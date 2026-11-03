-- 온라인 대원 실명: 텔레그램 닉네임 대신 보일 이름 (웹 관리자 '온라인 전도' 화면에서 고침). 없으면 텔레그램 이름
CREATE TABLE IF NOT EXISTS cdabot_online_names (
    poster_tg BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
