-- 활동 요일을 월~금(1~5)에서 월~일(1~7)로 확장
ALTER TABLE cdabot_avail_slots DROP CONSTRAINT IF EXISTS cdabot_avail_slots_weekday_check;
ALTER TABLE cdabot_avail_slots ADD CONSTRAINT cdabot_avail_slots_weekday_check CHECK (weekday BETWEEN 1 AND 7);
