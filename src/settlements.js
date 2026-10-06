const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 演员劳务结算：导演维护演员“每小时费率（非负整数，单位：分/小时）”，
 * 选择多个“已关闭（closed）”到场登记一次性生成结算单。
 *
 * 核心规则：
 *   - 仅已关闭（closed）登记可结算；已作废（voided）不能结算；
 *     关闭后日程才取消的登记（schedule_cancelled=1）仍可结算。
 *   - 仅冻结名单（attendance_roster）中“已签到”的演员计费；兼任多角只算一次
 *     （每个 登记×演员 至多一条明细）。
 *   - 金额 = 登记冻结的 UTC 时段秒数 × 结算时费率 ÷ 3600，逐登记逐人四舍五入到分。
 *   - 无费率、重复选择或登记已结算 -> 整单拒绝，不占用任何登记（不写任何数据）。
 *   - 单据冻结登记、演员、时长、费率和金额；后续调期、改派、替角、费率变更或取消日程均不改写。
 *   - 导演查看整单与合计；演员仅查看本人明细。
 *
 * 依赖方向：本模块只依赖 db；schedules.js / attendance.js 通过本模块导出的
 * settlementMarkForSession 读取登记的结算占用，避免循环依赖。
 */

const router = express.Router();
router.use(authRequired);

// ---- 通用辅助 ----

function getActorOrThrow(actorId) {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
  if (!u) throw badRequest(`演员 #${actorId} 不存在`);
  return u;
}

function rateOf(actorId) {
  return db.prepare('SELECT * FROM actor_rates WHERE actor_id = ?').get(actorId);
}

/** 某到场登记是否已被结算单占用（供日程/登记摘要展示） */
function settlementMarkForSession(attendanceSessionId) {
  const row = db
    .prepare('SELECT settlement_id, created_at FROM settlement_session_marks WHERE attendance_session_id = ?')
    .get(attendanceSessionId);
  return row
    ? { settled: true, settlementId: row.settlement_id, settledAt: row.created_at }
    : { settled: false, settlementId: null, settledAt: null };
}

function yuan(cents) {
  return (cents / 100).toFixed(2);
}

/** 登记冻结的 UTC 时段秒数（attendance_sessions 的 start_at/end_at 为开启时快照） */
function sessionDurationSeconds(session) {
  const ms = Date.parse(session.end_at) - Date.parse(session.start_at);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 1000);
}

/**
 * 逐登记逐人金额：seconds × rate(分/小时) ÷ 3600，四舍五入到分。
 * 金额非负，Math.round 即“四舍五入”（半数向更大值进位）。
 */
function amountCents(durationSeconds, rateCentsPerHour) {
  return Math.round((durationSeconds * rateCentsPerHour) / 3600);
}

function sessionBriefRow(a) {
  const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(a.scene_id);
  const rehearsal = db.prepare('SELECT id, name FROM rehearsals WHERE id = ?').get(a.rehearsal_id);
  const durationSeconds = sessionDurationSeconds(a);
  const mark = settlementMarkForSession(a.id);
  return {
    attendanceSessionId: a.id,
    scheduleId: a.schedule_id,
    rehearsalId: a.rehearsal_id,
    rehearsalName: rehearsal?.name ?? null,
    sceneId: a.scene_id,
    sceneCode: scene?.code ?? null,
    sceneTitle: scene ? `${scene.code} ${scene.title}` : null,
    startAt: a.start_at,
    endAt: a.end_at,
    durationSeconds,
    status: a.status,
    scheduleCancelled: !!a.schedule_cancelled,
    settled: mark.settled,
    settlementId: mark.settlementId,
  };
}

/**
 * 校验入参并构建单据内容（创建与预演共用；纯计算，不落库）。
 * 校验优先级：入参/重复 -> 不存在 -> 未关闭/已作废 -> 已结算 -> 无费率。
 * 返回 { note, sessionRows, entries, actorTotals, totalCents }。
 */
function buildSettlement(body) {
  const ids = body?.attendanceSessionIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest('attendanceSessionIds 必填且为非空数组（至少选择一个已关闭登记）');
  }
  const cleanIds = [];
  const seen = new Set();
  for (const raw of ids) {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
      throw badRequest('attendanceSessionIds 必须是登记 id（整数）的数组');
    }
    if (seen.has(raw)) {
      throw badRequest(`结算登记 #${raw} 在本单中重复选择，请去重后重试`, {
        code: 'SETTLEMENT_DUPLICATE_SESSION',
        duplicateSessionId: raw,
      });
    }
    seen.add(raw);
    cleanIds.push(raw);
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  // 不存在
  const sessions = cleanIds.map((id) => {
    const s = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(id);
    if (!s) throw notFound(`到场登记 #${id} 不存在`);
    return s;
  });
  // 未关闭 / 已作废
  for (const s of sessions) {
    if (s.status === 'voided') {
      throw badRequest(`登记 #${s.id} 已作废（日程在开放期被取消），不能结算`, {
        code: 'SETTLEMENT_VOIDED_SESSION',
        attendanceSessionId: s.id,
      });
    }
    if (s.status !== 'closed') {
      throw badRequest(`登记 #${s.id} 尚未关闭，仅已关闭登记可结算`, {
        code: 'SETTLEMENT_SESSION_NOT_CLOSED',
        attendanceSessionId: s.id,
      });
    }
  }
  // 已结算（占用标记）
  for (const s of sessions) {
    const mark = settlementMarkForSession(s.id);
    if (mark.settled) {
      throw conflict(
        'SETTLEMENT_SESSION_ALREADY_SETTLED',
        `登记 #${s.id} 已在结算单 #${mark.settlementId} 中结算，不能重复结算`,
        { attendanceSessionId: s.id, settlementId: mark.settlementId }
      );
    }
  }

  // 仅冻结名单中已签到者计费；兼任多角只算一次（roster 对 session×actor 唯一）
  const entries = [];
  const missingRateActors = new Map();
  for (const s of sessions) {
    const durationSeconds = sessionDurationSeconds(s);
    const rows = db
      .prepare(
        `SELECT ar.actor_id, ar.roles_json, u.display_name, u.username
           FROM attendance_roster ar
           JOIN users u ON u.id = ar.actor_id
          WHERE ar.session_id = ? AND ar.checked_in_at IS NOT NULL
          ORDER BY ar.id`
      )
      .all(s.id);
    for (const r of rows) {
      const rate = rateOf(r.actor_id);
      if (!rate) {
        if (!missingRateActors.has(r.actor_id)) {
          missingRateActors.set(r.actor_id, {
            actorId: r.actor_id,
            actorName: r.display_name,
            actorUsername: r.username,
          });
        }
        continue;
      }
      entries.push({
        session: s,
        actorId: r.actor_id,
        actorName: r.display_name,
        actorUsername: r.username,
        roles: JSON.parse(r.roles_json || '[]'),
        durationSeconds,
        rateCentsPerHour: rate.rate_cents_per_hour,
        amountCents: amountCents(durationSeconds, rate.rate_cents_per_hour),
      });
    }
  }
  if (missingRateActors.size > 0) {
    const actors = [...missingRateActors.values()];
    throw badRequest(
      `演员 ${actors.map((a) => `「${a.actorName}」`).join('、')} 尚未设置每小时费率，请先设置费率再结算`,
      { code: 'SETTLEMENT_RATE_MISSING', actors }
    );
  }

  const totalCents = entries.reduce((sum, e) => sum + e.amountCents, 0);
  const actorTotalsMap = new Map();
  for (const e of entries) {
    const cur = actorTotalsMap.get(e.actorId) || {
      actorId: e.actorId,
      actorName: e.actorName,
      actorUsername: e.actorUsername,
      totalCents: 0,
      entryCount: 0,
    };
    cur.totalCents += e.amountCents;
    cur.entryCount += 1;
    actorTotalsMap.set(e.actorId, cur);
  }

  return {
    note,
    sessions,
    entries,
    actorTotals: [...actorTotalsMap.values()].sort((a, b) => a.actorId - b.actorId),
    totalCents,
  };
}

// ---- 费率维护（导演）；演员可查本人费率 ----

// 导演：全部演员费率（未设置为 null；显式 0 与未设置区分）
router.get(
  '/actor-rates',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看演员费率表');
    const actors = db
      .prepare(
        `SELECT u.id AS actor_id, u.username, u.display_name,
                ar.rate_cents_per_hour, ar.updated_at
           FROM users u
           LEFT JOIN actor_rates ar ON ar.actor_id = u.id
          WHERE u.role = 'actor'
          ORDER BY u.id`
      )
      .all();
    res.json({
      actors: actors.map((a) => ({
        actorId: a.actor_id,
        username: a.username,
        displayName: a.display_name,
        rateCentsPerHour: a.rate_cents_per_hour ?? null,
        rateYuanPerHour: a.rate_cents_per_hour == null ? null : yuan(a.rate_cents_per_hour),
        configured: a.rate_cents_per_hour != null,
        updatedAt: a.updated_at ?? null,
      })),
    });
  })
);

// 演员：本人当前费率
router.get(
  '/me/rate',
  wrap((req, res) => {
    if (req.user.role !== 'actor') throw forbidden('仅演员可查看本人费率');
    const rate = rateOf(req.user.id);
    res.json({
      rate: rate
        ? {
            rateCentsPerHour: rate.rate_cents_per_hour,
            rateYuanPerHour: yuan(rate.rate_cents_per_hour),
            updatedAt: rate.updated_at ?? rate.created_at,
          }
        : null,
    });
  })
);

// 导演：设置（upsert）某演员的非负整数费率（分/小时）
router.put(
  '/actors/:actorId/rate',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可维护演员费率');
    const actorId = Number(req.params.actorId);
    if (!Number.isInteger(actorId)) throw badRequest('演员 id 必须为整数');
    getActorOrThrow(actorId);
    const value = req.body?.rateCentsPerHour;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw badRequest('rateCentsPerHour 必须是非负整数（单位：分/小时；0 表示费率为零）');
    }
    const existing = rateOf(actorId);
    if (existing) {
      db.prepare(
        `UPDATE actor_rates SET rate_cents_per_hour = ?, updated_by = ?, updated_at = datetime('now')
          WHERE actor_id = ?`
      ).run(value, req.user.id, actorId);
    } else {
      db.prepare(
        'INSERT INTO actor_rates (actor_id, rate_cents_per_hour, updated_by) VALUES (?, ?, ?)'
      ).run(actorId, value, req.user.id);
    }
    const rate = rateOf(actorId);
    res.json({
      ok: true,
      actorId,
      rateCentsPerHour: rate.rate_cents_per_hour,
      rateYuanPerHour: yuan(rate.rate_cents_per_hour),
      updatedAt: rate.updated_at ?? rate.created_at,
    });
  })
);

// ---- 可选登记清单（导演）：已关闭、未作废、未结算 ----

router.get(
  '/settlements/eligible-attendances',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看可结算登记');
    const rows = db
      .prepare(
        `SELECT a.* FROM attendance_sessions a
          WHERE a.status = 'closed'
            AND NOT EXISTS (SELECT 1 FROM settlement_session_marks m WHERE m.attendance_session_id = a.id)
          ORDER BY a.start_at, a.id`
      )
      .all();
    const sessions = rows.map((a) => {
      const brief = sessionBriefRow(a);
      const roster = db
        .prepare(
          `SELECT ar.actor_id, u.display_name, u.username, ar.checked_in_at
             FROM attendance_roster ar JOIN users u ON u.id = ar.actor_id
            WHERE ar.session_id = ? ORDER BY ar.id`
        )
        .all(a.id);
      const checkedInActors = roster
        .filter((r) => r.checked_in_at)
        .map((r) => {
          const rate = rateOf(r.actor_id);
          return {
            actorId: r.actor_id,
            actorName: r.display_name,
            actorUsername: r.username,
            hasRate: !!rate,
            rateCentsPerHour: rate?.rate_cents_per_hour ?? null,
          };
        });
      return {
        ...brief,
        expected: roster.length,
        checkedIn: checkedInActors.length,
        absent: roster.length - checkedInActors.length,
        checkedInActors,
        missingRate: checkedInActors.some((x) => !x.hasRate),
      };
    });
    res.json({ sessions });
  })
);

/** 预演结果视图（不落库） */
function serializePreview(plan) {
  return {
    canCreate: true,
    note: plan.note,
    total: { cents: plan.totalCents, yuan: yuan(plan.totalCents) },
    sessions: plan.sessions.map(sessionBriefRow),
    entries: plan.entries.map((e, idx) => ({
      rowNo: idx + 1,
      attendanceSessionId: e.session.id,
      actorId: e.actorId,
      actorName: e.actorName,
      roles: e.roles,
      durationSeconds: e.durationSeconds,
      rateCentsPerHour: e.rateCentsPerHour,
      amountCents: e.amountCents,
      amountYuan: yuan(e.amountCents),
    })),
    actorTotals: plan.actorTotals.map((t) => ({
      actorId: t.actorId,
      actorName: t.actorName,
      entryCount: t.entryCount,
      totalCents: t.totalCents,
      totalYuan: yuan(t.totalCents),
    })),
  };
}

// 预演（只读）：与创建同一套校验和计算
router.post(
  '/settlements/preview',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可预演结算单');
    const plan = buildSettlement(req.body || {});
    res.json({ preview: serializePreview(plan) });
  })
);

// ---- 创建结算单（导演）：整单事务；任何校验失败都不占用登记 ----

function serializeEntryRow(row) {
  return {
    id: row.id,
    attendanceSessionId: row.attendance_session_id,
    scheduleId: row.schedule_id,
    rehearsalId: row.rehearsal_id,
    sceneId: row.scene_id,
    actorId: row.actor_id,
    actorName: row.display_name,
    actorUsername: row.username,
    roles: JSON.parse(row.roles_json || '[]'),
    startAt: row.start_at,
    endAt: row.end_at,
    durationSeconds: row.duration_seconds,
    rateCentsPerHour: row.rate_cents_per_hour,
    amountCents: row.amount_cents,
    amountYuan: yuan(row.amount_cents),
  };
}

function listEntries(settlementId) {
  return db
    .prepare(
      `SELECT e.*, u.display_name, u.username
         FROM settlement_entries e JOIN users u ON u.id = e.actor_id
        WHERE e.settlement_id = ? ORDER BY e.id`
    )
    .all(settlementId);
}

function listSessions(settlementId) {
  return db
    .prepare(
      `SELECT a.* FROM settlement_session_marks m
         JOIN attendance_sessions a ON a.id = m.attendance_session_id
        WHERE m.settlement_id = ? ORDER BY a.start_at, a.id`
    )
    .all(settlementId);
}

/** 导演视图：整单（登记、明细、逐人合计与总计） */
function serializeSettlementForDirector(settlement) {
  const entries = listEntries(settlement.id).map(serializeEntryRow);
  const actorTotalsMap = new Map();
  for (const e of entries) {
    const cur = actorTotalsMap.get(e.actorId) || {
      actorId: e.actorId,
      actorName: e.actorName,
      actorUsername: e.actorUsername,
      totalCents: 0,
      entryCount: 0,
    };
    cur.totalCents += e.amountCents;
    cur.entryCount += 1;
    actorTotalsMap.set(e.actorId, cur);
  }
  return {
    id: settlement.id,
    status: settlement.status,
    note: settlement.note,
    createdAt: settlement.created_at,
    createdBy: settlement.created_by,
    total: { cents: settlement.total_cents, yuan: yuan(settlement.total_cents) },
    sessions: listSessions(settlement.id).map(sessionBriefRow),
    entries,
    actorTotals: [...actorTotalsMap.values()]
      .sort((a, b) => a.actorId - b.actorId)
      .map((t) => ({
        actorId: t.actorId,
        actorName: t.actorName,
        actorUsername: t.actorUsername,
        entryCount: t.entryCount,
        totalCents: t.totalCents,
        totalYuan: yuan(t.totalCents),
      })),
  };
}

/** 演员视图：仅本人明细（不含总计、他人明细或与本人无关的登记） */
function serializeSettlementForActor(settlement, actorId) {
  const rows = listEntries(settlement.id).filter((e) => e.actor_id === actorId);
  if (rows.length === 0) return null;
  const entries = rows.map(serializeEntryRow);
  const myTotalCents = entries.reduce((s, e) => s + e.amountCents, 0);
  return {
    id: settlement.id,
    status: settlement.status,
    note: settlement.note,
    createdAt: settlement.created_at,
    myTotal: { cents: myTotalCents, yuan: yuan(myTotalCents) },
    entries,
  };
}

router.post(
  '/settlements',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可生成结算单');
    // 校验在事务外完成（纯读）；事务内复查占用后写入，任何失败均整体回滚
    const plan = buildSettlement(req.body || {});
    const settlementId = transaction(() => {
      // 事务内复查：防止并发下同一登记被两单同时结算
      for (const s of plan.sessions) {
        if (db.prepare('SELECT 1 FROM settlement_session_marks WHERE attendance_session_id = ?').get(s.id)) {
          throw conflict('SETTLEMENT_SESSION_ALREADY_SETTLED', `登记 #${s.id} 已结算，请刷新后重试`, {
            attendanceSessionId: s.id,
          });
        }
      }
      const id = db
        .prepare('INSERT INTO settlements (note, total_cents, created_by) VALUES (?, ?, ?)')
        .run(plan.note, plan.totalCents, req.user.id).lastInsertRowid;
      const insEntry = db.prepare(
        `INSERT INTO settlement_entries
           (settlement_id, attendance_session_id, schedule_id, rehearsal_id, scene_id, actor_id,
            duration_seconds, rate_cents_per_hour, amount_cents, roles_json, start_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const e of plan.entries) {
        insEntry.run(
          id,
          e.session.id,
          e.session.schedule_id,
          e.session.rehearsal_id,
          e.session.scene_id,
          e.actorId,
          e.durationSeconds,
          e.rateCentsPerHour,
          e.amountCents,
          JSON.stringify(e.roles),
          e.session.start_at,
          e.session.end_at
        );
      }
      const insMark = db.prepare(
        'INSERT INTO settlement_session_marks (attendance_session_id, settlement_id) VALUES (?, ?)'
      );
      for (const s of plan.sessions) insMark.run(s.id, id);
      return id;
    });
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
    res.status(201).json({ settlement: serializeSettlementForDirector(settlement) });
  })
);

// ---- 查看：导演整单 / 演员仅本人明细 ----

router.get(
  '/settlements',
  wrap((req, res) => {
    if (req.user.role === 'director') {
      const rows = db.prepare('SELECT * FROM settlements ORDER BY id DESC').all();
      const settlements = rows.map((s) => {
        const full = serializeSettlementForDirector(s);
        // 列表给轻量摘要：id/时间/总额/登记数/演员数
        return {
          id: full.id,
          status: full.status,
          note: full.note,
          createdAt: full.createdAt,
          total: full.total,
          sessionCount: full.sessions.length,
          actorCount: full.actorTotals.length,
        };
      });
      return res.json({ settlements });
    }
    // 演员：仅含本人明细的结算单
    const rows = db
      .prepare(
        `SELECT DISTINCT s.* FROM settlements s
           JOIN settlement_entries e ON e.settlement_id = s.id
          WHERE e.actor_id = ? ORDER BY s.id DESC`
      )
      .all(req.user.id);
    const settlements = rows
      .map((s) => serializeSettlementForActor(s, req.user.id))
      .map((full) => ({
        id: full.id,
        status: full.status,
        note: full.note,
        createdAt: full.createdAt,
        myTotal: full.myTotal,
        entryCount: full.entries.length,
      }));
    res.json({ settlements });
  })
);

router.get(
  '/settlements/:id',
  wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('结算单 id 必须为整数');
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
    if (!settlement) throw notFound('结算单不存在');
    if (req.user.role === 'director') {
      return res.json({ settlement: serializeSettlementForDirector(settlement) });
    }
    const mine = serializeSettlementForActor(settlement, req.user.id);
    if (!mine) throw forbidden('你不是该结算单的当事人，仅可查看本人明细');
    res.json({ settlement: mine });
  })
);

module.exports = { router, settlementMarkForSession, sessionDurationSeconds, amountCents };
