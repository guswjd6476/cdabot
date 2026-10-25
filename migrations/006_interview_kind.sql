-- 인터뷰 구분: 향수행사 / 당터뷰 (결과지 제목에 '향수'가 있으면 향수행사)
ALTER TABLE cdabot_interviews ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '당터뷰';
