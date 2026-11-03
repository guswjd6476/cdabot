-- 온라인 대원 ↔ 웹 명단(members.고유번호). 웹 '온라인 전도' 화면에서 추천 이름 중에 골라 연결 (지역·구역은 명단에서 읽음)
ALTER TABLE cdabot_online_names ADD COLUMN IF NOT EXISTS member_code TEXT;
