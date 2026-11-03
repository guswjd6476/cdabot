-- 온라인 방 업무 (특전대·인터뷰와 별개, 조직 없이 방 단위)
--   dup:   인스타 아이디 중복 알림 + 매일 올린 사람별 건수
--   tally: '#주제 #지역 내용' 을 주제별·지역별로 취합
CREATE TABLE IF NOT EXISTS cdabot_rooms (
    chat_id BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('dup', 'tally')),
    title TEXT,
    relay BOOLEAN NOT NULL DEFAULT FALSE, -- 카운셀링 봇이 전달해 주는 방 (답·현황도 카운셀링 봇 이름으로)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, kind)
);

-- 카운셀링 봇이 취합 방 글을 넘겨줄 시다봇 주소(/relay)·비밀값. 같은 DB를 쓰므로 따로 설정할 필요 없음 (시다봇이 시작할 때 씀)
CREATE TABLE IF NOT EXISTS cdabot_relay (
    id INT PRIMARY KEY CHECK (id = 1),
    url TEXT NOT NULL,
    secret TEXT NOT NULL
);

-- 올라온 인스타 아이디 (메시지의 이름·메모는 저장하지 않음). dup = 같은 방에 먼저 올라온 아이디
CREATE TABLE IF NOT EXISTS cdabot_insta_posts (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    insta_id TEXT NOT NULL,
    poster_tg BIGINT NOT NULL,
    poster_name TEXT,
    posted_date DATE NOT NULL,
    dup BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cdabot_insta_posts_chat_id_idx ON cdabot_insta_posts (chat_id, insta_id);

CREATE TABLE IF NOT EXISTS cdabot_tally_posts (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    topic TEXT NOT NULL,
    region TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    poster_tg BIGINT NOT NULL,
    posted_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cdabot_tally_posts_chat_date_idx ON cdabot_tally_posts (chat_id, posted_date);
