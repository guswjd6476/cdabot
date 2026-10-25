-- 인터뷰 대상자의 마지막으로 확인한 행정 단계 (밤 점검에서 바뀐 사람만 관리자에게 알림). '탈락' 포함
ALTER TABLE cdabot_interviews ADD COLUMN IF NOT EXISTS last_stage TEXT;
