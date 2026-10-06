const crypto = require('crypto');
const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');
const { isScheduleParticipant, computePropShortages, unreturnedCheckoutTotals } = require('./props');

/**
 * 道具领用与归还（实物领用 / 分批归还 / 损坏核销）。
 *
 * 领用（导演，仅有效 active 时段）：
 *   - 从该时段的预约中办理实物领用，指定“该时段当前参与演员”（含生效临时替角）为保管人；
 *   - 各道具在本时段的累计领用量不得超过该时段预约量（409 PROP_CHECKOUT_EXCEEDS_RESERVATION）；
 *   - 跨时段未归还总量（领用 − 完好归还 − 损坏核销）不得超过道具现有库存
 *     （409 PROP_STOCK_INSUFFICIENT）；任一项不合格整次不生效（同一事务）。
 *   - 幂等请求号 requestId（全局唯一）：同号同内容重试返回首次结果（200，idempotentReplay）；
 *     同号异内容拒绝（409 REQUEST_ID_CONFLICT）。
 *
 * 归还（导演，按原领用记录分批登记）：
 *   - 一批可含该单多个道具的完好归还（good）与损坏（damaged）件数；
 *   - 同一（领用单 × 道具）累计归还（完好 + 损坏）不得超过未归还量（409 PROP_RETURN_EXCEEDS_OUTSTANDING）；
 *   - 损坏件数随即扣减 props.total_count；扣减后既有有效预约超量时保留预约并在响应
 *     与 GET /props/shortages 中显示缺口，后续预约与调期按新库存校验。
 *
 * 不可抹除：时段取消、转待调整、改派或换版均不改写领还流水；保管人在办理时冻结，
 * 原保管人的未归还责任保留（责任清单 GET /prop-checkouts）。
 *
 * 可见性：导演查看库存缺口与责任清单；演员仅查看本人领还流水（GET /me/prop-checkouts）。
 */

const router = express.Router();
router.use(authRequired);

// ---- 通用辅助 ----

function parsePositiveInt(value, field) {
  // 仅接受 JSON 数字（true/"3" 等隐式转换一律拒绝）
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

function getCheckoutRowOrThrow(id) {
  const c = db.prepare('SELECT * FROM prop_checkouts WHERE id = ?').get(id);
  if (!c) throw notFound(`道具领用单 #${id} 不存在`);
  return c;
}

function getScheduleRowOrThrow(scheduleId) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s) throw notFound(`排练时段 #${scheduleId} 不存在`);
  return s;
}

function scheduleBriefOf(scheduleId) {
  const s = db.prepare('SELECT * FROM rehearsal_schedules WHERE id = ?').get(scheduleId);
  if (!s) return null;
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

/** 某领用单各道具的累计归还（完好 / 损坏） */
function returnedTotals(checkoutId) {
  const rows = db
    .prepare(
      `SELECT prop_id, SUM(good_quantity) AS good, SUM(damaged_quantity) AS damaged
         FROM prop_returns WHERE checkout_id = ? GROUP BY prop_id`
    )
    .all(checkoutId);
  const map = new Map();
  for (const r of rows) map.set(r.prop_id, { good: r.good || 0, damaged: r.damaged || 0 });
  return map;
}

function serializeReturnRow(r) {
  return {
    id: r.id,
    propId: r.prop_id,
    propName: r.prop_name,
    goodQuantity: r.good_quantity,
    damagedQuantity: r.damaged_quantity,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/**
 * 领用单视图：时段摘要（实时状态，取消/待调整不抹除流水）、冻结保管人、
 * 各道具领用/已还/未还量与整单状态（outstanding=仍有未归还；cleared=已清）。
 * withReturns=true 时附完整归还流水（领用详情与演员本人流水用）。
 */
function serializeCheckout(row, { withReturns = false } = {}) {
  const items = db
    .prepare(
      `SELECT ci.prop_id, ci.quantity, p.name AS prop_name
         FROM prop_checkout_items ci JOIN props p ON p.id = ci.prop_id
        WHERE ci.checkout_id = ? ORDER BY ci.id`
    )
    .all(row.id);
  const ret = returnedTotals(row.id);
  const custodian = db
    .prepare('SELECT id, display_name, username FROM users WHERE id = ?')
    .get(row.custodian_actor_id);
  let totalQuantity = 0;
  let totalOutstanding = 0;
  const itemViews = items.map((it) => {
    const r = ret.get(it.prop_id) || { good: 0, damaged: 0 };
    const outstanding = it.quantity - r.good - r.damaged;
    totalQuantity += it.quantity;
    totalOutstanding += outstanding;
    return {
      propId: it.prop_id,
      propName: it.prop_name,
      quantity: it.quantity,
      returnedGood: r.good,
      returnedDamaged: r.damaged,
      outstanding,
    };
  });
  const view = {
    id: row.id,
    requestId: row.request_id,
    schedule: scheduleBriefOf(row.schedule_id),
    rehearsalId: row.rehearsal_id,
    custodian: {
      actorId: row.custodian_actor_id,
      actorName: custodian?.display_name ?? `#${row.custodian_actor_id}`,
      actorUsername: custodian?.username ?? null,
    },
    note: row.note,
    items: itemViews,
    totalQuantity,
    totalOutstanding,
    status: totalOutstanding > 0 ? 'outstanding' : 'cleared',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (withReturns) {
    view.returns = db
      .prepare(
        `SELECT r.*, p.name AS prop_name
           FROM prop_returns r JOIN props p ON p.id = r.prop_id
          WHERE r.checkout_id = ? ORDER BY r.id`
      )
      .all(row.id)
      .map(serializeReturnRow);
  }
  return view;
}

/** 幂等指纹：排练/时段/保管人/备注/明细（按道具排序归一化）的 SHA-256 */
function checkoutRequestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---- 导演：办理领用（幂等 requestId；整次生效/整次不生效） ----
router.post(
  '/rehearsals/:id/schedules/:scheduleId/prop-checkouts',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可办理道具领用');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isInteger(scheduleId)) throw badRequest('scheduleId 必须为整数');
    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    if (!r) throw notFound('排练不存在');
    const s = getScheduleRowOrThrow(scheduleId);
    if (s.rehearsal_id !== rehearsalId) throw notFound('该时段不属于此排练');

    // —— 结构校验（参与幂等指纹的字段先解析归一化）——
    const body = req.body || {};
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) throw badRequest('requestId（唯一请求号）必填');
    if (requestId.length > 200) throw badRequest('requestId 过长（最多 200 字符）');
    const custodianActorId = Number(body.custodianActorId);
    if (!Number.isInteger(custodianActorId)) throw badRequest('custodianActorId（保管人）必填且为整数');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('items 必填且为非空数组（每项含 propId 与正整数 quantity）');
    }
    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const propId = Number(item.propId);
      if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
      if (seen.has(propId)) throw badRequest(`${where}：批次中道具 #${propId} 重复`);
      seen.add(propId);
      const quantity = parsePositiveInt(item.quantity, `${where}：quantity（领用件数）`);
      parsed.push({ propId, quantity });
    });
    parsed.sort((a, b) => a.propId - b.propId);

    // —— 幂等：同号同内容重试返回首次结果；同号异内容拒绝 ——
    const hash = checkoutRequestHash({ rehearsalId, scheduleId, custodianActorId, note, items: parsed });
    const existing = db.prepare('SELECT * FROM prop_checkouts WHERE request_id = ?').get(requestId);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw conflict('REQUEST_ID_CONFLICT', `请求号「${requestId}」已被不同内容的领用请求使用，本次请求被拒绝`, {
          requestId,
        });
      }
      return res.json({ ok: true, idempotentReplay: true, checkout: serializeCheckout(existing, { withReturns: true }) });
    }

    // —— 业务校验 ——
    if (s.status !== 'active') {
      throw badRequest(
        s.status === 'cancelled'
          ? '时段已取消，不能办理道具领用（既有领还流水保留可查）'
          : '时段处于待调整状态，不能办理道具领用'
      );
    }
    const custodian = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(custodianActorId);
    if (!custodian) throw badRequest(`保管人 #${custodianActorId} 不存在或不是演员`);
    if (!isScheduleParticipant(scheduleId, custodianActorId)) {
      throw badRequest(`保管人「${custodian.display_name}」不是该时段当前参与演员，不能指定为保管人`);
    }

    // 各道具：本时段累计领用量 ≤ 本时段预约量；跨时段未归还总量 ≤ 现有库存
    const exceeds = [];
    const insufficient = [];
    const unreturnedMap = unreturnedCheckoutTotals();
    for (const { propId, quantity } of parsed) {
      const prop = db.prepare('SELECT * FROM props WHERE id = ?').get(propId);
      if (!prop) throw badRequest(`道具 #${propId} 不存在`);
      const reservation = db
        .prepare('SELECT quantity FROM prop_reservations WHERE schedule_id = ? AND prop_id = ?')
        .get(scheduleId, propId);
      const reserved = reservation?.quantity ?? 0;
      const alreadyOut = db
        .prepare(
          `SELECT COALESCE(SUM(ci.quantity), 0) AS q
             FROM prop_checkout_items ci
             JOIN prop_checkouts co ON co.id = ci.checkout_id
            WHERE co.schedule_id = ? AND ci.prop_id = ?`
        )
        .get(scheduleId, propId).q;
      if (alreadyOut + quantity > reserved) {
        exceeds.push({
          propId,
          propName: prop.name,
          scheduleId,
          reserved,
          alreadyCheckedOut: alreadyOut,
          requested: quantity,
          available: Math.max(0, reserved - alreadyOut),
        });
        continue;
      }
      const unreturned = unreturnedMap.get(propId) || 0;
      if (unreturned + quantity > prop.total_count) {
        insufficient.push({
          propId,
          propName: prop.name,
          totalCount: prop.total_count,
          unreturned,
          requested: quantity,
          available: Math.max(0, prop.total_count - unreturned),
        });
      }
    }
    if (exceeds.length) {
      throw conflict('PROP_CHECKOUT_EXCEEDS_RESERVATION', '领用总量超过本时段预约量，本次领用整次不生效', { exceeds });
    }
    if (insufficient.length) {
      throw conflict('PROP_STOCK_INSUFFICIENT', '跨时段未归还总量将超过现有库存，本次领用整次不生效', { insufficient });
    }

    const checkoutId = transaction(() => {
      // 事务内复查请求号（UNIQUE 约束兜底并发重试）
      const dup = db.prepare('SELECT id FROM prop_checkouts WHERE request_id = ?').get(requestId);
      if (dup) throw conflict('REQUEST_ID_CONFLICT', `请求号「${requestId}」已被使用`, { requestId });
      const id = db
        .prepare(
          `INSERT INTO prop_checkouts (request_id, request_hash, schedule_id, rehearsal_id, custodian_actor_id, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(requestId, hash, scheduleId, r.id, custodianActorId, note, req.user.id).lastInsertRowid;
      const ins = db.prepare('INSERT INTO prop_checkout_items (checkout_id, prop_id, quantity) VALUES (?, ?, ?)');
      for (const { propId, quantity } of parsed) ins.run(id, propId, quantity);
      return id;
    });
    res
      .status(201)
      .json({ ok: true, idempotentReplay: false, checkout: serializeCheckout(getCheckoutRowOrThrow(checkoutId), { withReturns: true }) });
  })
);

// ---- 导演：按原领用记录分批登记归还（完好 + 损坏；损坏扣减总库存） ----
router.post(
  '/prop-checkouts/:id/returns',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可登记道具归还');
    const checkoutId = Number(req.params.id);
    if (!Number.isInteger(checkoutId)) throw badRequest('领用单 id 必须为整数');
    const checkout = getCheckoutRowOrThrow(checkoutId);

    const body = req.body || {};
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('items 必填且为非空数组（每项含 propId 与非负整数 good/damaged，且二者至少其一为正）');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const checkoutQty = new Map(
      db.prepare('SELECT prop_id, quantity FROM prop_checkout_items WHERE checkout_id = ?').all(checkout.id).map((x) => [x.prop_id, x.quantity])
    );
    const ret = returnedTotals(checkout.id);

    const seen = new Set();
    const parsed = [];
    items.forEach((item, idx) => {
      const where = `第 ${idx + 1} 条`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest(`${where}：条目必须是对象`);
      const propId = Number(item.propId);
      if (!Number.isInteger(propId)) throw badRequest(`${where}：propId 必填且为整数`);
      if (seen.has(propId)) throw badRequest(`${where}：批次中道具 #${propId} 重复`);
      seen.add(propId);
      if (!checkoutQty.has(propId)) {
        throw badRequest(`${where}：道具 #${propId} 不在领用单 #${checkout.id} 中，不能对其登记归还`);
      }
      const good = item.good === undefined ? 0 : parseNonNegInt(item.good, `${where}：good（完好归还件数）`);
      const damaged = item.damaged === undefined ? 0 : parseNonNegInt(item.damaged, `${where}：damaged（损坏件数）`);
      if (good + damaged === 0) throw badRequest(`${where}：good 与 damaged 至少其一为正（本次登记无实际归还）`);
      parsed.push({ propId, good, damaged });
    });

    // 合计不得超过未归还量（任一项不合格整批不生效）
    const exceeds = [];
    for (const { propId, good, damaged } of parsed) {
      const checkedOut = checkoutQty.get(propId);
      const r = ret.get(propId) || { good: 0, damaged: 0 };
      const outstanding = checkedOut - r.good - r.damaged;
      if (good + damaged > outstanding) {
        const prop = db.prepare('SELECT name FROM props WHERE id = ?').get(propId);
        exceeds.push({
          propId,
          propName: prop?.name ?? null,
          checkedOut,
          alreadyReturned: r.good + r.damaged,
          outstanding,
          requested: good + damaged,
        });
      }
    }
    if (exceeds.length) {
      throw conflict('PROP_RETURN_EXCEEDS_OUTSTANDING', '归还合计超过未归还量，本次登记整批不生效', { exceeds });
    }

    const returnIds = transaction(() => {
      const ins = db.prepare(
        `INSERT INTO prop_returns (checkout_id, prop_id, good_quantity, damaged_quantity, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const ids = [];
      for (const { propId, good, damaged } of parsed) {
        ids.push(ins.run(checkout.id, propId, good, damaged, note, req.user.id).lastInsertRowid);
        if (damaged > 0) {
          // 损坏件数扣减道具总库存（未归还量 ≤ 现有库存，故不会扣成负数）
          db.prepare('UPDATE props SET total_count = total_count - ? WHERE id = ?').run(damaged, propId);
        }
      }
      return ids;
    });

    // 扣减后既有有效预约超量 -> 保留预约并显示缺口（不阻断归还）；后续预约/调期按新库存校验
    const shortages = computePropShortages();
    const returns = returnIds.map((id) =>
      serializeReturnRow(
        db
          .prepare('SELECT r.*, p.name AS prop_name FROM prop_returns r JOIN props p ON p.id = r.prop_id WHERE r.id = ?')
          .get(id)
      )
    );
    res.status(201).json({
      ok: true,
      returns,
      checkout: serializeCheckout(getCheckoutRowOrThrow(checkout.id), { withReturns: true }),
      shortages,
    });
  })
);

// ---- 导演：责任清单（全部领用单；?status=outstanding|cleared 过滤） ----
router.get(
  '/prop-checkouts',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看道具领用责任清单');
    const status = req.query.status;
    if (status != null && status !== '' && !['outstanding', 'cleared'].includes(status)) {
      throw badRequest('status 只能是 outstanding / cleared');
    }
    const rows = db.prepare('SELECT * FROM prop_checkouts ORDER BY id DESC').all();
    let views = rows.map((row) => serializeCheckout(row));
    if (status) views = views.filter((v) => v.status === status);
    res.json({ checkouts: views });
  })
);

// ---- 导演：领用单详情（含归还流水） ----
router.get(
  '/prop-checkouts/:id',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看道具领用单');
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('领用单 id 必须为整数');
    res.json({ checkout: serializeCheckout(getCheckoutRowOrThrow(id), { withReturns: true }) });
  })
);

// ---- 导演：某时段的领用记录 ----
router.get(
  '/rehearsals/:id/schedules/:scheduleId/prop-checkouts',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看时段道具领用记录');
    const rehearsalId = Number(req.params.id);
    const scheduleId = Number(req.params.scheduleId);
    if (!Number.isInteger(scheduleId)) throw badRequest('scheduleId 必须为整数');
    const r = db.prepare('SELECT * FROM rehearsals WHERE id = ?').get(rehearsalId);
    if (!r) throw notFound('排练不存在');
    const s = getScheduleRowOrThrow(scheduleId);
    if (s.rehearsal_id !== rehearsalId) throw notFound('该时段不属于此排练');
    const rows = db.prepare('SELECT * FROM prop_checkouts WHERE schedule_id = ? ORDER BY id DESC').all(s.id);
    res.json({ schedule: scheduleBriefOf(s.id), checkouts: rows.map((row) => serializeCheckout(row)) });
  })
);

// ---- 演员：本人领还流水（仅自己作为保管人的领用单及其归还记录） ----
router.get(
  '/me/prop-checkouts',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可查看本人领还流水');
    const rows = db
      .prepare('SELECT * FROM prop_checkouts WHERE custodian_actor_id = ? ORDER BY id DESC')
      .all(req.user.id);
    res.json({ checkouts: rows.map((row) => serializeCheckout(row, { withReturns: true })) });
  })
);

module.exports = { router };
