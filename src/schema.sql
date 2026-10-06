-- 剧团排练台词应用 数据库结构
-- 约定：
--   * versions / version_lines 为只增不改的发布快照（由触发器强制）
--   * lines.current_text 始终等于“最新已发布版本”中的文本；首版发布前是导演草稿
--   * 发布后的文本变动一律走 revisions / revision_items
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('director', 'actor')),
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id      INTEGER PRIMARY KEY,
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  code    TEXT NOT NULL,
  title   TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  UNIQUE (play_id, code)
);

CREATE TABLE IF NOT EXISTS roles (
  id      INTEGER PRIMARY KEY,
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  code    TEXT NOT NULL,
  name    TEXT NOT NULL,
  UNIQUE (play_id, code)
);

-- 现行台词（身份稳定，跨版本用同一 id）
CREATE TABLE IF NOT EXISTS lines (
  id           INTEGER PRIMARY KEY,
  play_id      INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  scene_id     INTEGER NOT NULL REFERENCES scenes(id),
  role_id      INTEGER NOT NULL REFERENCES roles(id),
  seq          INTEGER NOT NULL,
  current_text TEXT NOT NULL,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lines_play ON lines(play_id);

-- 已发布版本（不可改写）
CREATE TABLE IF NOT EXISTS versions (
  id              INTEGER PRIMARY KEY,
  play_id         INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  version_no      INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  base_version_id INTEGER REFERENCES versions(id),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (play_id, version_no)
);

-- 版本快照：每个版本包含的全部台词（删除的台词不出现在快照中）
CREATE TABLE IF NOT EXISTS version_lines (
  id        INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  line_id   INTEGER NOT NULL,
  scene_id  INTEGER NOT NULL,
  role_id   INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  text      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vl_version ON version_lines(version_id);
CREATE INDEX IF NOT EXISTS idx_vl_line ON version_lines(line_id);

-- 触发器：发布版本及其快照严禁 UPDATE / DELETE
CREATE TRIGGER IF NOT EXISTS trg_versions_no_update
BEFORE UPDATE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_versions_no_delete
BEFORE DELETE ON versions
BEGIN
  SELECT RAISE(ABORT, '已发布版本不可删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_version_lines_no_update
BEFORE UPDATE ON version_lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本快照不可改写');
END;
CREATE TRIGGER IF NOT EXISTS trg_version_lines_no_delete
BEFORE DELETE ON version_lines
BEGIN
  SELECT RAISE(ABORT, '已发布版本快照不可删除');
END;

CREATE TABLE IF NOT EXISTS revisions (
  id                 INTEGER PRIMARY KEY,
  play_id            INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  base_version_id    INTEGER NOT NULL REFERENCES versions(id),
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'merged', 'abandoned')),
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  merged_version_id  INTEGER REFERENCES versions(id),
  merged_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_play ON revisions(play_id);

CREATE TABLE IF NOT EXISTS revision_items (
  id          INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('modify', 'add', 'delete')),
  line_id     INTEGER REFERENCES lines(id),            -- modify/delete 指向既有台词；add 为空
  scene_id    INTEGER REFERENCES scenes(id),           -- add 时必填
  role_id     INTEGER REFERENCES roles(id),            -- add 时必填
  seq         INTEGER,                                  -- add 可选顺序
  old_text    TEXT NOT NULL DEFAULT '',                -- modify/delete 的原文
  new_text    TEXT NOT NULL DEFAULT ''                 -- modify/add 的新文
);
-- 同一修订内一条既有台词只能出现一次（add 的行 line_id 为 NULL，不受约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_items_line
  ON revision_items(revision_id, line_id) WHERE line_id IS NOT NULL;

-- 每次发布尝试（无论成功或因冲突未生效）都留痕
CREATE TABLE IF NOT EXISTS publish_attempts (
  id             INTEGER PRIMARY KEY,
  play_id        INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  new_version_id INTEGER REFERENCES versions(id),      -- 冲突时为空 = 本次发布未生效
  had_conflict   INTEGER NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  revision_ids   TEXT NOT NULL,                        -- JSON 数组
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_conflicts (
  id               INTEGER PRIMARY KEY,
  attempt_id       INTEGER NOT NULL REFERENCES publish_attempts(id) ON DELETE CASCADE,
  revision_id      INTEGER NOT NULL,
  revision_item_id INTEGER NOT NULL,
  line_id          INTEGER,
  kind             TEXT NOT NULL,  -- text_changed / line_deleted / batch_cross_edit
  reason           TEXT NOT NULL,
  base_text        TEXT NOT NULL DEFAULT '',
  current_text     TEXT NOT NULL DEFAULT ''
);

-- 排练：创建时固定引用一个版本
CREATE TABLE IF NOT EXISTS rehearsals (
  id         INTEGER PRIMARY KEY,
  play_id    INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

-- 派角：每个角色在一个排练中至多派给一名演员；改派=更新本行（确认会随之作废）
CREATE TABLE IF NOT EXISTS rehearsal_cast (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rehearsal_id, role_id)
);

CREATE TABLE IF NOT EXISTS rehearsal_version_log (
  id              INTEGER PRIMARY KEY,
  rehearsal_id    INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  from_version_id INTEGER NOT NULL,
  to_version_id   INTEGER NOT NULL,
  actor_id        INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 排练日程：导演为某场次安排的带时区起止时段（可同场次多段）
--   * status: active=有效；needs_adjustment=换版后该场次在新版本中已无台词，待调整；cancelled=已取消
--   * 起止时间以 ISO 8601 提交（必须带时区），服务端归一化为 UTC 存储
--   * 重叠判定为半开区间 [start, end)：端点相接不算重叠
--   * 参与者 = 排练当前固定版本中本场有台词且已派角的演员（动态计算，不落库）
CREATE TABLE IF NOT EXISTS rehearsal_schedules (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'needs_adjustment', 'cancelled')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_rehearsal ON rehearsal_schedules(rehearsal_id);

-- 演员不可用时段：演员登记/修改/撤销自己的不可用时间（带时区提交，服务端归一化为 UTC 存储）
--   * 结束必须晚于开始；重叠判定为半开区间 [start, end)：端点相接不算重叠
--   * 演员提交/修改时与本人当前参与的有效日程重叠 -> 整次拒绝并指出冲突日程
--   * 导演排期/调期、派角/改派、显式换版时，参与演员撞上不可用时段 -> 整次不生效
--   * 已取消与待调整日程不参与；开启过的到场登记名单与签到不因此改写
CREATE TABLE IF NOT EXISTS actor_unavailability (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at   TEXT NOT NULL,
  end_at     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_unavailability_actor ON actor_unavailability(actor_id);

-- 到场登记：导演为“有效”日程时段开启的一次性签到。
--   * 每个日程时段至多一次登记（schedule_id 唯一；已有登记——含已关闭/已作废——不得再开）
--   * 开启时冻结：场次、UTC 起止时段、排练当时固定版本；此后改派/换版/调整日程均不回写
--   * status: open=开放签到；closed=导演已关闭（未签到者记缺席）；voided=开放期间日程被取消
--     （作废：停止签到，已签到痕迹保留但不计出勤）
--   * schedule_cancelled=1：登记关闭后日程又被取消，仅标注，原统计保留
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id                 INTEGER PRIMARY KEY,
  schedule_id        INTEGER NOT NULL UNIQUE REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  rehearsal_id       INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  scene_id           INTEGER NOT NULL REFERENCES scenes(id),
  version_id         INTEGER NOT NULL REFERENCES versions(id),
  start_at           TEXT NOT NULL,
  end_at             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'closed', 'voided')),
  opened_by          INTEGER REFERENCES users(id),
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by          INTEGER REFERENCES users(id),
  closed_at          TEXT,
  schedule_cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attendance_rehearsal ON attendance_sessions(rehearsal_id);

-- 登记名单（开启时冻结）：当时“本场次有台词且已派角”的演员；未派角角色不计应到。
-- checked_in_at 为空 = 未签到；登记关闭后仍未签即缺席。后来加入者不在名单，不能签到。
CREATE TABLE IF NOT EXISTS attendance_roster (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  roles_json    TEXT NOT NULL DEFAULT '[]',
  checked_in_at TEXT,
  UNIQUE (session_id, actor_id)
);

-- 缺口（开启时冻结）：当时本场次有台词但未派角的角色，仅展示，不计应到。
CREATE TABLE IF NOT EXISTS attendance_gaps (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id),
  UNIQUE (session_id, role_id)
);

-- 演员按“所派角色 × 场次”确认；content_hash 对应确认时排练固定版本的台词文本。
-- 唯一键含 actor_id：角色改派后保留原演员的历史确认（不计入），新演员需重新确认。
CREATE TABLE IF NOT EXISTS confirmations (
  id            INTEGER PRIMARY KEY,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  actor_id      INTEGER NOT NULL REFERENCES users(id),
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  content_hash  TEXT NOT NULL,
  confirmed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rehearsal_id, role_id, scene_id, actor_id)
);

-- 单个时段的临时替角（导演在签到开启前临时替换某角色的到场演员）：
--   * 仅对“该排练 × 该时段 × 该角色”生效：改变该时段最终参与者、通知接收人与替角可见的本场台词；
--     不改变常驻派角 rehearsal_cast 与逐场确认 confirmations，临时台词权限不扩展到其他场次/时段。
--   * 同一角色同一时段至多一个生效替角（部分唯一索引）；替换/撤回采用“旧行失效 + 新行”方式留历史。
--   * status: active=生效中；invalidated=已失效（撤回、改派/撤派、角色失去台词、时段取消/待调整等）。
--   * 失效后不再占用演员；取消/待调整期间不占用，恢复有效后须重新设置并重新校验。
--   * 已开启签到的时段冻结名单，不再允许设置/撤回（路由层拒绝，本表不回写签到快照）。
CREATE TABLE IF NOT EXISTS schedule_substitutes (
  id                 INTEGER PRIMARY KEY,
  schedule_id        INTEGER NOT NULL REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  rehearsal_id       INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  role_id            INTEGER NOT NULL REFERENCES roles(id),
  original_actor_id  INTEGER NOT NULL REFERENCES users(id),
  substitute_actor_id INTEGER NOT NULL REFERENCES users(id),
  reason             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'invalidated')),
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  invalidated_reason TEXT NOT NULL DEFAULT '', -- withdrawn / cast_changed / cast_unassigned / role_no_lines / schedule_cancelled / schedule_pending_adjustment
  invalidated_at     TEXT
);
-- 同一角色同一时段只保留一个生效替角（失效行保留为历史，不受唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_substitutes_one_active
  ON schedule_substitutes(schedule_id, role_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_substitutes_rehearsal ON schedule_substitutes(rehearsal_id);
CREATE INDEX IF NOT EXISTS idx_substitutes_actor ON schedule_substitutes(substitute_actor_id);

-- 时段通知批次：导演调整排练安排后，演员需确认知悉当前时段。
--   * 有效时段创建、起止/场次变化，以及派角/撤派/显式换版使该时段参与演员、角色或
--     固定版本变化时，按最终结果生成新批次；无实质变化（fingerprint 相同）不重复生成。
--   * 批次冻结：UTC 起止时段、场次、固定版本与当时参与演员（接收人表）。
--   * status: current=当前有效批次（计当前待确认）；superseded=已被新批次取代（保留不计）；
--     inactive=时段已取消或待调整（不再待确认，恢复有效时生成新批次）。
--   * 批次随原操作事务提交：排期/不可用冲突导致原操作失败时不留批次。
CREATE TABLE IF NOT EXISTS schedule_notifications (
  id            INTEGER PRIMARY KEY,
  schedule_id   INTEGER NOT NULL REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  rehearsal_id  INTEGER NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,                -- 该时段内第几批（从 1 递增）
  scene_id      INTEGER NOT NULL REFERENCES scenes(id),
  version_id    INTEGER NOT NULL REFERENCES versions(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,                   -- 实质内容指纹（时段/场次/版本/参与演员及角色）
  status        TEXT NOT NULL DEFAULT 'current'
                  CHECK (status IN ('current', 'superseded', 'inactive')),
  reason        TEXT NOT NULL DEFAULT '',        -- create / adjust / batch_adjust / cast / batch_cast / version_switch / substitute
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_notifications_schedule ON schedule_notifications(schedule_id);
CREATE INDEX IF NOT EXISTS idx_notifications_rehearsal ON schedule_notifications(rehearsal_id);

-- 批次接收人（生成时冻结的当时参与演员及其角色）；confirmed_at 为空 = 待确认。
-- 确认幂等：重试返回首次确认时间；过期（非 current）批次的确认被拒绝。
CREATE TABLE IF NOT EXISTS schedule_notification_recipients (
  id              INTEGER PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES schedule_notifications(id) ON DELETE CASCADE,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  roles_json      TEXT NOT NULL DEFAULT '[]',
  confirmed_at    TEXT,
  UNIQUE (notification_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_actor ON schedule_notification_recipients(actor_id);

-- 剧团共享道具：导演登记各道具的非负整数总件数（库存），按排练时段预约。
--   * 仅“有效（active）”时段的预约占用库存；已取消（cancelled）与待调整（needs_adjustment）
--     时段的预约随记录保留但不占用——取消/换版转待调整时释放，待调整恢复有效时重新校验。
--   * 占用按带时区时段归一化后的半开区间 [start, end) 计算：端点相接可复用。
--   * 同一道具任一时刻全部有效时段的预约总量不得超过 props.total_count。
CREATE TABLE IF NOT EXISTS props (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 时段道具预约：一个时段对一个道具至多一行（0 件不保留行，即“撤销”）。
-- 占用与否由 rehearsal_schedules.status 动态决定（active 才计入），本表不复制状态。
-- 单条与批量调期（PATCH / batch-adjust）时，预约随时段的场次与起止时间一起移动；
-- 取消时段后预约行保留为历史痕迹（不再占用，且不可再改）。
CREATE TABLE IF NOT EXISTS prop_reservations (
  id          INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES rehearsal_schedules(id) ON DELETE CASCADE,
  prop_id     INTEGER NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL CHECK (quantity >= 0),
  updated_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE (schedule_id, prop_id)
);
CREATE INDEX IF NOT EXISTS idx_prop_reservations_prop ON prop_reservations(prop_id);
CREATE INDEX IF NOT EXISTS idx_prop_reservations_schedule ON prop_reservations(schedule_id);

-- 演员每小时劳务费率（导演维护，非负整数，单位：分/小时）。
--   * 仅演员有费率；没有行 = 未设置费率（结算时整单拒绝），显式 0 = 费率为零，可正常结算为 0 元。
--   * 费率可随时调整；结算单冻结的是“结算时费率”（settlement_entries.rate_cents_per_hour），
--     之后改费率不影响已生成的结算单。
CREATE TABLE IF NOT EXISTS actor_rates (
  actor_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rate_cents_per_hour  INTEGER NOT NULL CHECK (rate_cents_per_hour >= 0),
  updated_by          INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT
);

-- 劳务结算单：导演选择“多个已关闭（closed，且未作废）”的到场登记一次性生成。
--   * 只有“已关闭”的登记可纳入；已作废（voided）不能结算；关闭后日程才取消的登记仍可结算。
--   * 仅冻结名单中“已签到”的演员计费，兼任多角只算一次（每个 登记×演员 至多一条）。
--   * 金额 = 登记冻结的 UTC 时段秒数 × 结算时费率 ÷ 3600，逐登记逐人四舍五入到分。
--   * 无费率、重复选择或登记已结算 -> 整单拒绝，不占用任何登记（不写任何数据）。
--   * 单据一旦生成即冻结登记、演员、时长、费率和金额；后续调期/改派/替角/费率变更/取消日程均不改写。
CREATE TABLE IF NOT EXISTS settlements (
  id           INTEGER PRIMARY KEY,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('final')),
  total_cents  INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 结算单明细：一条 = 某结算单 × 某次已关闭登记 × 某个已签到演员（兼任多角仍只一条）。
-- duration_seconds 取自登记冻结的 UTC 时段（attendance_sessions.start_at/end_at），
-- rate_cents_per_hour 取自生成单据时的演员费率，amount_cents 已按规则四舍五入。
-- 任一登记至多被结算一次：settlement_session_marks 以部分唯一约束强制占用。
CREATE TABLE IF NOT EXISTS settlement_entries (
  id                      INTEGER PRIMARY KEY,
  settlement_id           INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  attendance_session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id),
  schedule_id             INTEGER NOT NULL REFERENCES rehearsal_schedules(id),
  rehearsal_id            INTEGER NOT NULL REFERENCES rehearsals(id),
  scene_id                INTEGER NOT NULL REFERENCES scenes(id),
  actor_id                INTEGER NOT NULL REFERENCES users(id),
  duration_seconds        INTEGER NOT NULL CHECK (duration_seconds >= 0),
  rate_cents_per_hour     INTEGER NOT NULL CHECK (rate_cents_per_hour >= 0),
  amount_cents            INTEGER NOT NULL CHECK (amount_cents >= 0),
  roles_json              TEXT NOT NULL DEFAULT '[]',
  start_at                TEXT NOT NULL,
  end_at                  TEXT NOT NULL,
  UNIQUE (settlement_id, attendance_session_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_settlement_entries_settlement ON settlement_entries(settlement_id);
CREATE INDEX IF NOT EXISTS idx_settlement_entries_actor ON settlement_entries(actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_entries_session_actor
  ON settlement_entries(attendance_session_id, actor_id);

-- 登记“被结算单占用”标记：一个登记至多属于一张结算单（即使该登记无人签到也占一行）。
-- 用独立表而非 attendance_sessions 加列，避免对只增快照式到场登记模块的写入耦合。
CREATE TABLE IF NOT EXISTS settlement_session_marks (
  attendance_session_id INTEGER PRIMARY KEY REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  settlement_id         INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settlement_marks_settlement ON settlement_session_marks(settlement_id);
