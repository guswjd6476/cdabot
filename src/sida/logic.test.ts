// 순수 로직 테스트 (DB 없음). 실행: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimetable, dayStatus, mergeSlots, parseRange, parseRanges, parseWeekText, Slot, totalMinutes } from './time';
import { countBy, missingCount, normalizePhone, parseSlashForms, toCsv, validateField } from './result';

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

test('한 메시지 주간 입력 파싱', () => {
    const r = parseWeekText('월/09:00-14:00,18:00-21:00 화/12:00-14:00\n수 / 불가 토요일:10~12')!;
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.days, {
        1: { unavailable: false, slots: [[540, 840], [1080, 1260]] },
        2: { unavailable: false, slots: [[720, 840]] },
        3: { unavailable: true, slots: [] },
        6: { unavailable: false, slots: [[600, 720]] },
    });
    assert.deepEqual(parseWeekText('월/9-12 월/13-15')!.errors, ['월요일이 두 번 적혀 있습니다.']);
    assert.deepEqual(parseWeekText('월/ 화/9-12')!.errors, ['월요일 시간이 비어 있습니다.']);
    assert.equal(parseWeekText('오늘 9-12 회의'), null); // 요일 표시 없음
    assert.equal(parseWeekText('발/홍길동/010/20대중'), null);
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

test('[8] 발굴건 한 줄 양식 → 필드별 정리 (제목 줄 무시, 2차 만남 두 가지 표기)', () => {
    const [r] = parseSlashForms('❗️발굴건\n발/홍길동/010 1234 5678/20대중/남/서울/1팀/김철수/전단지/+10.28 19시,강남역 카페');
    assert.equal(r.kind, 'dig');
    assert.deepEqual(r.values, {
        name: '홍길동',
        phone: '010 1234 5678',
        age_group: '20대중',
        gender: '남',
        region: '서울',
        team: '1팀',
        guide: '김철수',
        tool: '전단지',
        meet_at: '10.28 19시',
        meet_place: '강남역 카페',
    });
    assert.deepEqual(r.notes, []);
    const [slash] = parseSlashForms('발 / 김 / 01011112222 / 30대 / 여 / 부산 / 2팀 / 이 / 책자 / 10.29 오후2시 / 서면');
    assert.deepEqual([slash.values.meet_at, slash.values.meet_place], ['10.29 오후2시', '서면']);
    assert.deepEqual(validateField('phone', r.values.phone!), { ok: true, value: '010-1234-5678' });
    assert.deepEqual(validateField('age_group', '20대중'), { ok: true, value: '20대 중' });
});

test('[8] 찾기건 한 줄 양식', () => {
    const [r] = parseSlashForms('찾／이몽룡／990315／대전／3팀／성춘향／11월'); // 전각 슬래시도 인식
    assert.equal(r.kind, 'find');
    assert.deepEqual(r.values, { name: '이몽룡', birth_date: '990315', region: '대전', team: '3팀', guide: '성춘향', target_month: '11월' });
    assert.equal(validateField('birth_date', '모름').ok, false);
    assert.equal(missingCount({ kind: 'find', name: 'a', birth_date: '1', region: 'x', team: 'y', guide: 'z' }), 1); // 찾기건 항목만 셈
});

test('[9] 빈 칸·모자란 칸은 추측하지 않음', () => {
    const [r] = parseSlashForms('발/홍길동//20대 중/남/서울');
    assert.deepEqual(Object.keys(r.values), ['name', 'age_group', 'gender', 'region']); // 연락처(빈 칸), 인도팀~장소(없음)는 다시 질문
    const [over] = parseSlashForms('찾/가/1/대전/3팀/나/11월/추가칸');
    assert.equal(over.values.target_month, undefined); // 칸이 남으면 어디가 밀렸는지 모름 → 다시 질문
    assert.equal(over.notes.length, 1);
    assert.deepEqual(parseSlashForms('오늘 발 아파요\n발굴건 화이팅'), []); // 양식이 아닌 대화
    assert.equal(parseSlashForms('발/a/b\n찾/c/d').length, 2);
    assert.equal(validateField('age_group', '25살').ok, false);
    assert.equal(validateField('phone', '12').ok, false);
    assert.deepEqual(validateField('phone', '5678'), { ok: true, value: '5678' }); // 뒷자리만
    assert.equal(validateField('gender', '기타', ['남', '여']).ok, false); // 목록 밖 값 임의 분류 안 함
    assert.deepEqual(validateField('region', '대전', ['서울']), { ok: true, value: '대전' }); // 직접 입력 허용
    assert.equal(normalizePhone('02-123-4567'), '021234567');
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
