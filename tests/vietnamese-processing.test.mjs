import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVietnameseWord } from '../src/utils/vietnamese-detector.js';
import { transliterateWord } from '../src/utils/transliterator.js';

test('"khoai tây" không bị bẻ thành "choai tây"', () => {
    assert.equal(isVietnameseWord('khoai'), true);
    assert.equal(transliterateWord('khoai'), 'khoai');
    assert.notEqual(transliterateWord('khoai'), 'choai');
});

test('họ vần oa/oe/ua/uy mở rộng được coi là tiếng Việt', () => {
    assert.equal(isVietnameseWord('khoay'), true);
    assert.equal(isVietnameseWord('thoai'), true);
    assert.equal(isVietnameseWord('ngoeo'), true);
    assert.equal(isVietnameseWord('khuya'), true);
    assert.equal(isVietnameseWord('huya'), true);
});

test('các âm tiết "kh" không bị quy tắc C/K bẻ thành "ch"', () => {
    assert.equal(transliterateWord('khaki'), 'kha-ki');
    assert.equal(transliterateWord('khmer'), 'khmơ');
});
