-- 중복확인 양식 '아이디/이름/나이/거주지/이성친구유무/기타사항' 의 칸과 인스타 주소 (추적용 ?뒤 값은 빼고 저장)
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS age TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS residence TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS relationship TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS url TEXT;
