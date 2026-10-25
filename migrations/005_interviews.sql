-- 인터뷰 결과 추적 (특전대와 별개 모듈: module_key = 'interview')
-- 같은 날 같은 이름은 한 건 (결과지를 고쳐 다시 올리면 덮어씀)
-- student_id: 카운셀링 봇 DB의 students.id (읽기만 함). 연결 전이면 NULL
CREATE TABLE IF NOT EXISTS cdabot_interviews (
    id SERIAL PRIMARY KEY,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    user_id INT NOT NULL REFERENCES cdabot_users(id),
    interview_date DATE NOT NULL,
    name TEXT,
    name_key TEXT NOT NULL,
    follow_up TEXT CHECK (follow_up IN ('O', '보류', 'X')),
    region TEXT,
    guides TEXT[] NOT NULL DEFAULT '{}',
    interviewer TEXT,
    phone TEXT,
    birth_date TEXT,
    memo TEXT,
    student_id TEXT,
    match_note TEXT, -- 'none' 행정에 없음 / 'multi' 후보 여러 명
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pii_purged_at TIMESTAMPTZ,
    UNIQUE (org_id, interview_date, name_key)
);
CREATE INDEX IF NOT EXISTS cdabot_interviews_org_date_idx ON cdabot_interviews (org_id, interview_date);
