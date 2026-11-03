-- 새 양식 '지역/인도자/아이디/이름/나이/거주지/이성친구유무/기타사항' 의 지역·인도자
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE cdabot_insta_posts ADD COLUMN IF NOT EXISTS guide TEXT;
