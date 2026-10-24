-- 결과 양식 2종: 발굴건(dig) / 찾기건(find). 기존 결과는 발굴건으로 간주
-- 기존 bal 컬럼은 남겨둠 (더 이상 쓰지 않음 — '발'은 값이 아니라 발굴건 표시였음)
ALTER TABLE cdabot_results
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dig',
    ADD COLUMN IF NOT EXISTS birth_date TEXT,
    ADD COLUMN IF NOT EXISTS meet_at TEXT,
    ADD COLUMN IF NOT EXISTS meet_place TEXT,
    ADD COLUMN IF NOT EXISTS target_month TEXT;
