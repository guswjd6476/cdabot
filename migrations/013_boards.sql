-- maeum(코칭존)이 보낸 누적 결과지를 사람이 복사해 고쳐 올린 마지막 글 (방·날짜별). maeum 이 다음 신청 때 이 글 뒤에 이어 붙임
CREATE TABLE IF NOT EXISTS cdabot_boards (
    chat_id BIGINT NOT NULL,
    day DATE NOT NULL,
    text TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, day)
);
