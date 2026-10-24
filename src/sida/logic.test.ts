// 순수 로직 테스트 (DB 없음). 실행: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimetable, dayStatus, mergeSlots, parseRange, parseRanges, Slot, totalMinutes } from './time';
import { countBy, missingCount, normalizePhone, parseFreeForm, toCsv, validateField } from './result';

const h = (s: string) => {
    const r = parseRanges(s);
    assert.deepEqual(r.errors, []);
    return r.slots;
};

test('[1] 09:00~12:00 + 14:00~17:00 = 6시간, 충족', () => {
    const slots = h('09:00~12:00, 14:00~17:00');
    assert.equal(totalMinutes(slots), 360);
    assert.equal(dayStatus({ unavailable: false, slots }), 'ok');
});

test('[2] 하루 4시간은 미충족', () => {
    assert.equal(dayStatus({ unavailable: false, slots: h('10:00~14:00') }), 'short');
});

test('[3] 겹치는 구간은 중복 합산하지 않음 (09~12 + 11~14 = 5시간, 미충족)', () => {
    const slots = h('09:00~12:00\n11:00~14:00');
    assert.equal(totalMinutes(slots), 300);
    assert.equal(dayStatus({ unavailable: false, slots }), 'short');
    assert.deepEqual(mergeSlots(slots), [[540, 840]]);
});

test('[4] 구간 1개 / 2개 / 3개 이상, 고정 시간대 없음', () => {
    assert.equal(totalMinutes(h('08:00~14:00')), 360);
    assert.equal(totalMinutes(h('10:00~13:00, 14:00~17:00')), 360);
    assert.equal(totalMinutes(h('09:00~11:00, 13:00~15:00, 19:00~21:00')), 360);
    assert.equal(totalMinutes(h('09:00~12:00, 13:00~15:00, 18:00~20:00')), 420);
    assert.equal(totalMinutes(h('06:15~07:45, 9-10, 10:30~11:00, 22:00~24:00')), 90 + 60 + 30 + 120);
});

test('시간 입력 형식과 오류', () => {
    assert.deepEqual(parseRange('09:00-12:00'), { slot: [540, 720] });
    assert.deepEqual(parseRange('９:３０～１２:００'), { slot: [570, 720] }); // 전각
    assert.match((parseRange('12:00~12:00') as any).error, /같습니다/);
    assert.match((parseRange('22:00~02:00') as any).error, /자정/); // 자정 넘김 미지원
    assert.match((parseRange('15:00~13:00') as any).error, /빠릅니다/);
    assert.match((parseRange('25:00~26:00') as any).error, /없는 시각/);
    assert.match((parseRange('24:30~24:40') as any).error, /없는 시각/);
    assert.match((parseRange('아침') as any).error, /형식/);
});

test('[7] 미제출 / 활동 불가 / 충족 / 미충족 구분', () => {
    assert.equal(dayStatus(undefined), 'missing');
    assert.equal(dayStatus({ unavailable: true, slots: [] }), 'unavailable');
    assert.equal(dayStatus({ unavailable: false, slots: [] }), 'short');
    assert.equal(dayStatus({ unavailable: false, slots: h('09:00~15:30') }, 390), 'ok'); // 기준 변경
});

test('[5][17] 타임테이블 — 실제 구간 경계로 나누고, 개인 합계와 일치', () => {
    const segs = buildTimetable([
        { name: 'A', slots: h('09:00~12:00, 14:00~17:00') },
        { name: 'B', slots: h('09:00~13:00') },
        { name: 'C', slots: h('11:00~13:00, 15:00~17:00') },
        { name: 'D', slots: h('14:00~17:00') },
    ]);
    assert.deepEqual(
        segs.map((s) => [s.start / 60, s.end / 60, s.names.join('')]),
        [
            [9, 11, 'AB'],
            [11, 12, 'ABC'],
            [12, 13, 'BC'],
            [14, 15, 'AD'],
            [15, 17, 'ACD'],
        ]
    );
    // 무작위 12명 × 무작위 구간에서도 '시간표에서 그 사람이 있는 구간 길이 합' = 개인 총시간
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const entries = Array.from({ length: 12 }, (_, i) => ({
        name: `대원${i}`,
        slots: Array.from({ length: 1 + rnd(4) }, () => {
            const s = rnd(40) * 30;
            return [s, s + 30 * (1 + rnd(12))] as Slot;
        }).filter(([, e]) => e <= 1440),
    }));
    const table = buildTimetable(entries);
    for (const en of entries) {
        const inTable = table.filter((s) => s.names.includes(en.name)).reduce((sum, s) => sum + s.end - s.start, 0);
        assert.equal(inTable, totalMinutes(en.slots), en.name);
    }
});

test('[8] 자유 형식 결과 → 필드별 정리', () => {
    const r = parseFreeForm('발: 3\n이름: 홍길동\n연락처: 010 1234 5678\n생년: 20대 중\n성별: 남\n인도지역: 서울\n인도팀: 1팀\n인도자: 김철수\n도구: 전단지');
    assert.equal(r.recognized, 9);
    assert.deepEqual(r.values, {
        bal: '3',
        name: '홍길동',
        phone: '010 1234 5678',
        age_group: '20대 중',
        gender: '남',
        region: '서울',
        team: '1팀',
        guide: '김철수',
        tool: '전단지',
    });
    assert.deepEqual(validateField('phone', r.values.phone!), { ok: true, value: '010-1234-5678' });
    assert.deepEqual(validateField('age_group', '20대중'), { ok: true, value: '20대 중' });
});

test('[9] 누락·불명확 값은 추측하지 않음', () => {
    const r = parseFreeForm('이름: 홍길동\n연락처:\n생년: 20대 중\n도구: 전단\n도구: 책자\n메모: 아무거나');
    assert.equal(r.values.phone, undefined); // 비어 있으면 누락
    assert.equal(r.values.bal, undefined); // 아예 없는 항목
    assert.equal(r.values.tool, undefined); // 서로 다른 값 두 번 → 다시 질문
    assert.deepEqual(r.conflicts, ['tool']);
    assert.equal(validateField('age_group', '25살').ok, false);
    assert.equal(validateField('phone', '1234').ok, false);
    assert.equal(validateField('gender', '기타', ['남', '여']).ok, false); // 목록 밖 값 임의 분류 안 함
    assert.deepEqual(validateField('region', '대전', ['서울']), { ok: true, value: '대전' }); // 직접 입력 허용
    assert.equal(normalizePhone('02-123-4567'), '021234567');
    assert.equal(missingCount({ name: 'a', phone: null }), 8);
});

test('[16] CSV — BOM, 한글, 따옴표·쉼표·줄바꿈, 수식 주입 방지', () => {
    const buf = toCsv(['이름', '메모'], [['홍길동', '쉼표,"따옴표"\n줄바꿈'], ['=1+1', '-@x'], ['2026-10-24 13:05', null]]);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(buf.toString('utf8').slice(1), '이름,메모\r\n홍길동,"쉼표,""따옴표""\n줄바꿈"\r\n\'=1+1,\'-@x\r\n2026-10-24 13:05,\r\n');
});

test('countBy — 미입력은 따로', () => {
    assert.deepEqual(countBy([{ r: '서울' }, { r: null }, { r: '서울' }, { r: '부산' }], 'r'), [
        ['서울', 2],
        ['부산', 1],
        ['(미입력)', 1],
    ]);
});
