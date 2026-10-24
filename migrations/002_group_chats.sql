-- 관리자가 등록한 특전대 단체방: 이 방에서 봇을 쓰는 사람은 해당 조직 대원으로 자동 등록
CREATE TABLE IF NOT EXISTS cdabot_group_chats (
    chat_id BIGINT NOT NULL,
    module_key TEXT NOT NULL,
    org_id INT NOT NULL REFERENCES cdabot_orgs(id),
    title TEXT,
    created_by INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, module_key)
);
