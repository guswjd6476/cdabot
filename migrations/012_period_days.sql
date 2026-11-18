-- 특전대 기간을 아무 요일에서 시작해 N일(1~7)로 (예: 4.5기 3일 특전대). week_start = 시작일, 기존 주차는 월요일 시작 7일 그대로
ALTER TABLE cdabot_periods ADD COLUMN IF NOT EXISTS days SMALLINT NOT NULL DEFAULT 7 CHECK (days BETWEEN 1 AND 7);
