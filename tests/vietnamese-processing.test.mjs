import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVietnameseWord } from '../src/utils/vietnamese-detector.js';
import { transliterateWord } from '../src/utils/transliterator.js';
import { forceVietnamesePhonemes, hasStandaloneWord, VIETNAMESE_PHONEME_OVERRIDES } from '../src/utils/phoneme-fix.js';

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

test('"veo" đứng độc lập được nhận diện để ép đọc Việt', () => {
    assert.equal(hasStandaloneWord('veo', 'veo'), true);
    assert.equal(hasStandaloneWord('Veo', 'veo'), true);
    assert.equal(hasStandaloneWord('con veo cái lá', 'veo'), true);
    assert.equal(hasStandaloneWord('google veo 3', 'veo'), true);
    assert.equal(hasStandaloneWord('veo.', 'veo'), true);
    // Không ăn nhầm từ gạch nối (Velcarian -> veo-ca-ri-an) hay từ khác
    assert.equal(hasStandaloneWord('veo-ca-ri-an', 'veo'), false);
    assert.equal(hasStandaloneWord('video', 'veo'), false);
    assert.equal(hasStandaloneWord('véo', 'veo'), false);
});

test('"veo" bị espeak tag (en) được ép về phoneme Việt', () => {
    const expected = VIETNAMESE_PHONEME_OVERRIDES.veo.replacement;
    // Dạng tag thô từ phonemizer: đứng 1 mình (tone 7) và trong câu (tone 1)
    assert.equal(
        forceVietnamesePhonemes('veo', '(en)vˈiː7əʊəʊ(vi)', 'vi'),
        expected
    );
    assert.equal(
        forceVietnamesePhonemes('con veo cái lá', 'x (en)vˈiː1əʊəʊ(vi) y', 'vi'),
        `x ${expected} y`
    );
    // Dạng đã strip marker vẫn được fix
    assert.equal(forceVietnamesePhonemes('veo', 'vˈiː7əʊəʊ', 'vi'), expected);
    // Voice Anh không bị đụng
    assert.equal(
        forceVietnamesePhonemes('veo', '(en)vˈiː7əʊəʊ(vi)', 'en-us'),
        '(en)vˈiː7əʊəʊ(vi)'
    );
    // Từ khác / từ gạch nối không bị đụng
    assert.equal(forceVietnamesePhonemes('keo', 'kˈɛ7w', 'vi'), 'kˈɛ7w');
    assert.equal(
        forceVietnamesePhonemes('veo-ca-ri-an', '(en)vˈiː7əʊəʊ(vi)', 'vi'),
        '(en)vˈiː7əʊəʊ(vi)'
    );
});
