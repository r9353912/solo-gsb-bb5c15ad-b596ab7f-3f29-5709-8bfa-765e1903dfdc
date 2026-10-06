const crypto = require('crypto');
const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const { isScheduleParticipant, computePropShortages } = require('./props');

/**
 * 共享道具实物领用 / 归还。
 *
 * 领用（导演）：
 *   - 只能从“有效（active）”时段的有效预约中办理；指定一名“该时段当前参与演员”为保管人。
 *   - 一次请求可领多个道具（每项正整数件数），整次校验：
 *       (a) 每道具“该时段历次领用总量（毛额，含已归还）+ 本次件数”不得超过本时段预约量；
 *       (b) 每道具“跨时段未归还总量 + 本次件数”不得超过现有库存 props.total_count；
 *       (c) 保管人确为该时段当前参与者。
 *     任一项不合格 -> 整次不生效（不写任何流水），409 PROP_LOAN_REJECTED。
 *   - requestNo 唯一请求号（按导演唯一）：同号同内容重试返回首次原结果（幂等重放）；
 *     同号异内容 409 PROP_LOAN_REQUEST_CONFLICT 拒绝。
 *
 * 归还（导演）：
 *   - 按原领用记录分批登记 { good（完好）, damaged（损坏）} 件数；合计不得超过该明细未归还量。
 *   - 损坏件数在归还事务内扣减 props.total_count（不会为负）；
 *     扣减后既有有效预约可能超量——保留预约并在库存缺口视图显示；
 *     后续预约与调期按新库存校验（见 props.js 的“不得扩大缺口”口径）。
 *
 * 不抹除：取消 / 转待调整 / 改派 / 换版均不删除领还流水；时段与原保管人仅作留痕，
 *   原保管人的未归还责任始终挂在本人名下（归还仍按原领用单逐条登记）。
 *
 * 可见性：导演查看库存缺口与责任清单、任意流水；演员仅查看本人领还流水。
 */

const router = express.Router();
router.use(authRequired);

function parsePosInt(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} 必须是正整数`);
  }
  return value;
}

function parseNonNegInt(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${field} 必须是非负整数`);
  }
  return value;
}

function getLoanOrThrow(loanId) {
  const loan = db.prepare('SELECT * FROM prop_loans WHERE id = ?').get(loanId);
  if (!loan) throw notFound(`领用记录 #${loanId} 不存在`);
  return loan;
}

/** 幂等指纹：规范化请求内容（requestNo 不参与指纹）。 */
function loanContentHash({ scheduleId, custodianActorId, items, note = '' }) {
  const canonical = JSON.stringify({
    scheduleId,
    custodianActorId,
    note: String(note ?? ''),
    items: items
      .map((it) => ({ propId: it.propId, quantity: it.quantity }))
      .sort((a, b) => a.propId - b.propId),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---- 序列化 ----

function actorBrief(actorId) {
  const u = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(actorId);
  return u ? { id: u.id, username: u.username, displayName: u.display_name } : null;
}

function scheduleBrief(s) {
  const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(s.scene_id);
  const rehearsal = db.prepare('SELECT id, name FROM rehearsals WHERE id = ?').get(s.rehearsal_id);
  return {
    id: s.id,
    rehearsalId: s.rehearsal_id,
    rehearsalName: rehearsal?.name ?? null,
    sceneId: s.scene_id,
    sceneTitle: scene ? `${scene.code} ${scene.title}` : null,
    startAt: s.start_at,
    endAt: s.end_at,
    status: s.status,
  };
}

function loanItems(loanId) {
  return db
    .prepare('SELECT * FROM prop_loan_items WHERE loan_id = ? ORDER BY id')
    .all(loanId)
    .map((it) => ({
      id: it.id,
      propId: it.prop_id,
      propName: it.prop_name,
      quantity: it.quantity,
      returnedGood: it.returned_good,
      returnedDamaged: it.returned_damaged,
      outstanding: it.quantity - it.returned_good - it.returned_damaged,
    }));
}

function returnBatches(loanId) {
  const batches = db.prepare('SELECT * FROM prop_returns WHERE loan_id = ? ORDER BY id').all(loanId);
  return batches.map((b) => ({
    id: b.id,
    note: b.note,
    createdBy: actorBrief(b.created_by),
    createdAt: b.created_at,
    items: db
      .prepare('SELECT * FROM prop_return_items WHERE return_id = ? ORDER BY id')
      .all(b.id)
      .map((ri) => ({
        loanItemId: ri.loan_item_id,
        propId: ri.prop_id,
        good: ri.good_count,
        damaged: ri.damaged_count,
      })),
  }));
}

function serializeLoan(loan) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(loan.schedule_id);
  return {
    id: loan.id,
    requestNo: loan.request_no,
    note: loan.note,
    schedule: s ? scheduleBrief(s) : null,
    custodian: actorBrief(loan.custodian_actor_id),
    createdBy: actorBrief(loan.created_by),
    createdAt: loan.created_at,
    items: loanItems(loan.id),
    returns: returnBatches(loan.id),
  };
}

// ---- 导演：办理实物领用 ----
router.post(
  '/prop-loans',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可办理道具领用');

    const requestNo = String(req.body?.requestNo ?? '').trim();
    if (!requestNo) throw badRequest('requestNo（唯一请求号）必填');
    const scheduleId = Number(req.body?.scheduleId);
    if (!Number.isInteger(scheduleId)) throw badRequest('scheduleId 必填且为整数');
    const custodianActorId = Number(req.body?.custodianActorId);
    if (!Number.isInteger(custodianActorId)) throw badRequest('custodianActorId 必填且为整数');
    const note = String(req.body?.note ?? '');

    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('请求体须为非空 items 数组（每项含 propId 与正整数 quantity）');
    }
    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const propId = Number(item.propId);
      if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
      if (seen.has(propId)) throw badRequest(`${where}：同一次领用中道具 #${propId} 重复`);
      seen.add(propId);
      const quantity = parsePosInt(item.quantity, `${where}：quantity（领用件数）`);
      parsed.push({ propId, quantity });
    });

    const contentHash = loanContentHash({ scheduleId, custodianActorId, items: parsed, note });

    // 幂等：同导演的同请求号
    const existing = db
      .prepare('SELECT * FROM prop_loans WHERE created_by = ? AND request_no = ?')
      .get(req.user.id, requestNo);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw conflict(
          'PROP_LOAN_REQUEST_CONFLICT',
          `请求号「${requestNo}」已用于另一条领用请求，同号异内容拒绝；同号重试须保持完全相同的请求体`,
          { requestNo, existingLoanId: existing.id }
        );
      }
      // 同号同内容：返回首次原结果（重放）
      return res.json({ ok: true, replayed: true, loan: serializeLoan(existing) });
    }

    // 静态资格校验（事务前，错误信息明确；这些条件即便重试也不会变）
    const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
    if (!s) throw notFound(`排练时段 #${scheduleId} 不存在`);
    if (s.status !== 'active') {
      throw badRequest('只能为有效（active）时段办理实物领用；取消/待调整时段的既有流水仍可归还');
    }
    const custodian = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'actor'").get(custodianActorId);
    if (!custodian) throw badRequest(`保管人演员 #${custodianActorId} 不存在`);
    if (!isScheduleParticipant(scheduleId, custodianActorId)) {
      throw badRequest('保管人必须是该时段当前参与的演员（常驻派角或该时段生效替角）');
    }
    for (const { propId } of parsed) {
      const p = db.prepare('SELECT id FROM props WHERE id = ?').get(propId);
      if (!p) throw badRequest(`道具 #${propId} 不存在`);
    }

    const rejection = transaction(() => {
      // 事务内复查，防止并发下的陈旧读取（better-sqlite3 串行执行，双保险）
      const row = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
      if (!row || row.status !== 'active') return { reason: '时段已不是有效状态，领用未生效' };
      if (!isScheduleParticipant(scheduleId, custodianActorId)) {
        return { reason: '保管人不是该时段当前参与演员，领用未生效' };
      }

      const itemProblems = [];
      for (const it of parsed) {
        const prop = db.prepare('SELECT * FROM props WHERE id = ?').get(it.propId);
        if (!prop) {
          itemProblems.push({ propId: it.propId, code: 'PROP_NOT_FOUND', message: '道具不存在' });
          continue;
        }
        // (a) 本时段预约量与该时段历史毛领用总量
        const reserve = db
          .prepare('SELECT quantity FROM prop_reservations WHERE schedule_id = ? AND prop_id = ?')
          .get(scheduleId, it.propId);
        const reserved = reserve?.quantity ?? 0;
        const alreadyForSlot = db
          .prepare(
            `SELECT COALESCE(SUM(pli.quantity), 0) AS n
               FROM prop_loan_items pli
               JOIN prop_loans pl ON pl.id = pli.loan_id
              WHERE pl.schedule_id = ? AND pli.prop_id = ?`
          )
          .get(scheduleId, it.propId).n;
        if (alreadyForSlot + it.quantity > reserved) {
          itemProblems.push({
            propId: it.propId,
            propName: prop.name,
            code: 'OVER_SLOT_RESERVATION',
            message: '该道具本时段领用总量将超过本时段预约量',
            reserved,
            alreadyLoanedForSlot: alreadyForSlot,
            requested: it.quantity,
            remaining: Math.max(0, reserved - alreadyForSlot),
          });
        }
        // (b) 跨时段未归还总量 + 本次件数 <= 现有库存
        const outstanding = db
          .prepare(
            `SELECT COALESCE(SUM(pli.quantity - pli.returned_good - pli.returned_damaged), 0) AS n
               FROM prop_loan_items pli WHERE pli.prop_id = ?`
          )
          .get(it.propId).n;
        if (outstanding + it.quantity > prop.total_count) {
          itemProblems.push({
            propId: it.propId,
            propName: prop.name,
            code: 'OVER_STOCK',
            message: '跨时段未归还总量加本次领用将超过现有库存',
            totalCount: prop.total_count,
            outstandingAcrossSlots: outstanding,
            requested: it.quantity,
            available: Math.max(0, prop.total_count - outstanding),
          });
        }
      }
      if (itemProblems.length) {
        return { reason: '领用校验未通过，整次未生效', items: itemProblems };
      }

      const loanId = db
        .prepare(
          `INSERT INTO prop_loans
             (request_no, schedule_id, rehearsal_id, scene_id, custodian_actor_id, note, content_hash, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          requestNo,
          scheduleId,
          row.rehearsal_id,
          row.scene_id,
          custodianActorId,
          note,
          contentHash,
          req.user.id
        ).lastInsertRowid;
      const insItem = db.prepare(
        'INSERT INTO prop_loan_items (loan_id, prop_id, prop_name, quantity) VALUES (?, ?, ?, ?)'
      );
      for (const it of parsed) {
        const prop = db.prepare('SELECT name FROM props WHERE id = ?').get(it.propId);
        insItem.run(loanId, it.propId, prop.name, it.quantity);
      }
      return { loanId };
    });

    if (rejection.loanId == null) {
      throw conflict('PROP_LOAN_REJECTED', rejection.reason || '领用未生效', rejection.items ? { items: rejection.items } : undefined);
    }
    res.status(201).json({ ok: true, replayed: false, loan: serializeLoan(getLoanOrThrow(rejection.loanId)) });
  })
);

// ---- 导演：按原领用记录分批登记归还 ----
router.post(
  '/prop-loans/:loanId/returns',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可登记道具归还');
    const loanId = Number(req.params.loanId);
    if (!Number.isInteger(loanId)) throw badRequest('loanId 必须为整数');
    const loan = getLoanOrThrow(loanId);

    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('请求体须为非空 items 数组（每项含 loanItemId、good 与/或 damaged 非负整数）');
    }
    const note = String(req.body?.note ?? '');
    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const loanItemId = Number(item.loanItemId);
      if (!Number.isInteger(loanItemId)) throw badRequest(`${where}：loanItemId 必填且为整数`);
      if (seen.has(loanItemId)) throw badRequest(`${where}：领用明细 #${loanItemId} 在本批重复`);
      seen.add(loanItemId);
      const good = item.good === undefined ? 0 : parseNonNegInt(item.good, `${where}：good（完好件数）`);
      const damaged = item.damaged === undefined ? 0 : parseNonNegInt(item.damaged, `${where}：damaged（损坏件数）`);
      if (good + damaged === 0) throw badRequest(`${where}：good 与 damaged 至少一项为正`);
      parsed.push({ loanItemId, good, damaged });
    });

    const result = transaction(() => {
      // 逐条按原领用明细校验未归还量（任一条超额整批不生效）
      const problems = [];
      for (const it of parsed) {
        const li = db.prepare('SELECT * FROM prop_loan_items WHERE id = ? AND loan_id = ?').get(it.loanItemId, loan.id);
        if (!li) {
          problems.push({ loanItemId: it.loanItemId, code: 'ITEM_NOT_FOUND', message: '领用明细不存在或不属于该领用记录' });
          continue;
        }
        const outstanding = li.quantity - li.returned_good - li.returned_damaged;
        if (it.good + it.damaged > outstanding) {
          problems.push({
            loanItemId: it.loanItemId,
            propId: li.prop_id,
            propName: li.prop_name,
            code: 'OVER_OUTSTANDING',
            message: '本批归还（完好+损坏）合计超过该明细未归还量',
            outstanding,
            requested: it.good + it.damaged,
          });
        }
      }
      if (problems.length) {
        return { rejected: { reason: '归还校验未通过，整批未生效', items: problems } };
      }

      const returnId = db
        .prepare('INSERT INTO prop_returns (loan_id, note, created_by) VALUES (?, ?, ?)')
        .run(loan.id, note, req.user.id).lastInsertRowid;
      const insRI = db.prepare(
        'INSERT INTO prop_return_items (return_id, loan_item_id, prop_id, good_count, damaged_count) VALUES (?, ?, ?, ?, ?)'
      );
      const incReturn = db.prepare(
        'UPDATE prop_loan_items SET returned_good = returned_good + ?, returned_damaged = returned_damaged + ? WHERE id = ?'
      );
      // 损坏件数按道具汇总扣减总库存（不会为负）
      const damagedByProp = new Map();
      for (const it of parsed) {
        const li = db.prepare('SELECT * FROM prop_loan_items WHERE id = ?').get(it.loanItemId);
        insRI.run(returnId, it.loanItemId, li.prop_id, it.good, it.damaged);
        incReturn.run(it.good, it.damaged, it.loanItemId);
        damagedByProp.set(li.prop_id, (damagedByProp.get(li.prop_id) ?? 0) + it.damaged);
      }
      const stockAfter = [];
      for (const [propId, damaged] of damagedByProp) {
        if (damaged <= 0) continue;
        db.prepare('UPDATE props SET total_count = MAX(0, total_count - ?) WHERE id = ?').run(damaged, propId);
        const p = db.prepare('SELECT id, name, total_count FROM props WHERE id = ?').get(propId);
        stockAfter.push({ propId: p.id, propName: p.name, damagedDeducted: damaged, totalCount: p.total_count });
      }
      return { returnId, stockAfter };
    });

    if (result.rejected) {
      throw conflict('PROP_RETURN_REJECTED', result.rejected.reason, { items: result.rejected.items });
    }
    const updated = getLoanOrThrow(loan.id);
    // 损坏扣库存后可能出现的既有有效预约缺口（保留预约，仅展示）
    const damagedPropIds = result.stockAfter.map((x) => x.propId);
    const shortages = damagedPropIds.length ? computePropShortages({ propIds: damagedPropIds }) : [];
    res.status(201).json({
      ok: true,
      returnId: result.returnId,
      stockAfter: result.stockAfter,
      reservationShortages: shortages,
      loan: serializeLoan(updated),
    });
  })
);

// ---- 导演：库存缺口（损坏扣库存后既有有效预约超量清单） ----
router.get(
  '/props/shortages',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看库存缺口');
    res.json({ shortages: computePropShortages() });
  })
);

// ---- 导演：领用责任清单（所有尚有未归还实物的领用明细，按保管人归并） ----
router.get(
  '/prop-loans/responsibilities',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看领用责任清单');
    const rows = db
      .prepare(
        `SELECT pli.*, pl.schedule_id, pl.custodian_actor_id, pl.id AS loan_id, pl.request_no
           FROM prop_loan_items pli
           JOIN prop_loans pl ON pl.id = pli.loan_id
          WHERE pli.quantity - pli.returned_good - pli.returned_damaged > 0
          ORDER BY pl.custodian_actor_id, pl.id, pli.id`
      )
      .all();
    const byCustodian = new Map();
    for (const r of rows) {
      if (!byCustodian.has(r.custodian_actor_id)) {
        byCustodian.set(r.custodian_actor_id, { custodian: actorBrief(r.custodian_actor_id), items: [] });
      }
      const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(r.schedule_id);
      byCustodian.get(r.custodian_actor_id).items.push({
        loanId: r.loan_id,
        requestNo: r.request_no,
        loanItemId: r.id,
        propId: r.prop_id,
        propName: r.prop_name,
        quantity: r.quantity,
        returnedGood: r.returned_good,
        returnedDamaged: r.returned_damaged,
        outstanding: r.quantity - r.returned_good - r.returned_damaged,
        schedule: s ? scheduleBrief(s) : null,
      });
    }
    const custodians = [...byCustodian.values()];
    const totalOutstanding = rows.reduce(
      (sum, r) => sum + (r.quantity - r.returned_good - r.returned_damaged),
      0
    );
    res.json({ custodians, totalOutstandingItems: totalOutstanding });
  })
);

// ---- 领用单列表 / 详情 ----
router.get(
  '/prop-loans',
  wrap((req, res) => {
    if (req.user.role === 'director') {
      const scheduleId = req.query.scheduleId ? Number(req.query.scheduleId) : null;
      const custodianActorId = req.query.custodianActorId ? Number(req.query.custodianActorId) : null;
      const where = [];
      const params = [];
      if (scheduleId) {
        where.push('pl.schedule_id = ?');
        params.push(scheduleId);
      }
      if (custodianActorId) {
        where.push('pl.custodian_actor_id = ?');
        params.push(custodianActorId);
      }
      const sql = `SELECT pl.* FROM prop_loans pl ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pl.id`;
      const loans = db.prepare(sql).all(...params);
      return res.json({ loans: loans.map(serializeLoan) });
    }
    if (req.user.role !== 'actor') throw forbidden();
    // 演员：仅本人作为保管人的领用单（含已取消/待调整时段——责任不抹除）
    const loans = db
      .prepare('SELECT * FROM prop_loans WHERE custodian_actor_id = ? ORDER BY id')
      .all(req.user.id);
    res.json({ loans: loans.map(serializeLoan) });
  })
);

router.get(
  '/prop-loans/:loanId',
  wrap((req, res) => {
    const loanId = Number(req.params.loanId);
    if (!Number.isInteger(loanId)) throw badRequest('loanId 必须为整数');
    const loan = getLoanOrThrow(loanId);
    if (req.user.role === 'actor' && loan.custodian_actor_id !== req.user.id) {
      throw forbidden('演员仅可查看本人作为保管人的领还流水');
    }
    if (req.user.role !== 'director' && req.user.role !== 'actor') throw forbidden();
    res.json({ loan: serializeLoan(loan) });
  })
);

// ---- 演员：本人领还流水（精简视图） ----
router.get(
  '/me/prop-loans',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员有本人领还流水视图');
    const loans = db
      .prepare('SELECT * FROM prop_loans WHERE custodian_actor_id = ? ORDER BY id')
      .all(req.user.id);
    res.json({ loans: loans.map(serializeLoan) });
  })
);

module.exports = { router };
