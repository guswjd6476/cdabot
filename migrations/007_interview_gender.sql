-- 새 인터뷰 양식(섭외자/성별/연락처/…)의 성별. 예전 양식으로 올린 건은 NULL
ALTER TABLE cdabot_interviews ADD COLUMN IF NOT EXISTS gender TEXT;
