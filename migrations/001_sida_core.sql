-- 시다봇 공통 엔진 + 특전대 모듈 스키마 (기존 cdabot_chats / cdabot_reports 는 건드리지 않음)
-- 모든 문장은 IF NOT EXISTS / ON CONFLICT 로 여러 번 실행해도 안전

CREATE TABLE IF NOT EXISTS cdabot_orgs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 조직별 모듈(역할) 설정. settings 예: {"min_minutes":360,"pii_retention_days":365}
CREATE TABLE IF NOT EXISTS cdabot_modules (
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    module_key TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    settings JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (org_id, module_key)
);

CREATE TABLE IF NOT EXISTS cdabot_users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL UNIQUE,
    tg_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 조직 × 사용자 × 모듈 단위 권한. perms: member / manager / pii
CREATE TABLE IF NOT EXISTS cdabot_memberships (
    id SERIAL PRIMARY KEY,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    user_id INT NOT NULL REFERENCES cdabot_users(id),
    module_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    perms TEXT[] NOT NULL DEFAULT '{member}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'inactive', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, user_id, module_key)
);

-- 활동 취합 주차 (week_start = 월요일). 새 주차는 새 행이라 과거 주차를 덮어쓰지 않음
CREATE TABLE IF NOT EXISTS cdabot_periods (
    id SERIAL PRIMARY KEY,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    module_key TEXT NOT NULL,
    week_start DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    extra_editors INT[] NOT NULL DEFAULT '{}', -- 마감 후에도 수정 허용된 user_id
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    UNIQUE (org_id, module_key, week_start)
);

CREATE TABLE IF NOT EXISTS cdabot_avail_submissions (
    id SERIAL PRIMARY KEY,
    period_id INT NOT NULL REFERENCES cdabot_periods(id),
    user_id INT NOT NULL REFERENCES cdabot_users(id),
    unavailable_days SMALLINT[] NOT NULL DEFAULT '{}', -- 활동 불가로 명시한 요일 (1=월 … 5=금)
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (period_id, user_id)
);

-- 시간은 0시 기준 분 (09:30 = 570). 자정을 넘는 구간은 지원하지 않음 (end_min 최대 1440 = 24:00)
CREATE TABLE IF NOT EXISTS cdabot_avail_slots (
    id SERIAL PRIMARY KEY,
    submission_id INT NOT NULL REFERENCES cdabot_avail_submissions(id) ON DELETE CASCADE,
    weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 5),
    start_min SMALLINT NOT NULL CHECK (start_min >= 0),
    end_min SMALLINT NOT NULL CHECK (end_min <= 1440),
    CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS cdabot_avail_slots_sub_idx ON cdabot_avail_slots (submission_id);

-- 당일 결과. dedup_key 로 같은 메시지/같은 확인 버튼 재처리 시 중복 저장 방지
CREATE TABLE IF NOT EXISTS cdabot_results (
    id SERIAL PRIMARY KEY,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    user_id INT NOT NULL REFERENCES cdabot_users(id),
    activity_date DATE NOT NULL,
    bal TEXT,
    name TEXT,
    phone TEXT,
    age_group TEXT,
    gender TEXT,
    region TEXT,
    team TEXT,
    guide TEXT,
    tool TEXT,
    dedup_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    pii_purged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS cdabot_results_org_date_idx ON cdabot_results (org_id, activity_date);

-- field: region / team / guide / tool / gender
CREATE TABLE IF NOT EXISTS cdabot_field_options (
    id SERIAL PRIMARY KEY,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    sort INT NOT NULL DEFAULT 0,
    UNIQUE (org_id, field, value)
);

CREATE TABLE IF NOT EXISTS cdabot_schedule_snapshots (
    id SERIAL PRIMARY KEY,
    period_id INT NOT NULL REFERENCES cdabot_periods(id),
    generated_by INT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS cdabot_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    org_id INT,
    actor_user_id INT,
    action TEXT NOT NULL,
    target TEXT,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 진행 중인 입력 흐름 (봇 재시작 후에도 이어서 입력 가능)
CREATE TABLE IF NOT EXISTS cdabot_sessions (
    telegram_id BIGINT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 초기값: 기본 조직 1개 + 성별 선택지 (관리자가 /특전대 옵션 으로 변경 가능)
INSERT INTO cdabot_orgs (name) VALUES ('기본 조직') ON CONFLICT (name) DO NOTHING;
INSERT INTO cdabot_field_options (org_id, field, value, sort)
SELECT id, 'gender', v.value, v.sort FROM cdabot_orgs, (VALUES ('남', 1), ('여', 2)) AS v(value, sort)
WHERE name = '기본 조직'
ON CONFLICT (org_id, field, value) DO NOTHING;
