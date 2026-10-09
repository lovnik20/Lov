/* qa_inject.js — инжектится в страницу через page.evaluate
 * Возвращает массив проблем для текущего состояния DOM */

(function(){
  'use strict';

  const VW = 1080, VH = 1920;
  const TOLERANCE = 2; /* пикселей запаса */

  /* классы/селекторы которые не считаем при overlap */
  const OVERLAP_IGNORE = ['.stamp', '.tag', '.stamp-circle', '.merge-result'];

  const issues = {
    overflow_viewport: [],
    overflow_container: [],
    overlap: [],
    stuck_filter: null,
    zero_size: [],
    tiny_text: [],
    numbers_as_words: [],
    oversized_text: [],
    debug_visible_elements: 0
  };

  const MIN_FONT_SIZE = 40; /* px — правило Ули: меньше нечитаемо с телефона */

  function describe(el){
    let s = el.tagName.toLowerCase();
    if(el.id) s += '#' + el.id;
    if(el.className && typeof el.className === 'string'){
      s += '.' + el.className.split(/\s+/).slice(0,2).join('.');
    }
    const txt = (el.textContent||'').trim().slice(0, 40);
    if(txt) s += ' "' + txt + '"';
    return s;
  }

  function isVisible(el){
    const cs = getComputedStyle(el);
    if(cs.display === 'none') return false;
    if(cs.visibility === 'hidden') return false;
    if(parseFloat(cs.opacity) < 0.1) return false;
    /* проверяем родителей — opacity цепочка */
    let p = el.parentElement;
    while(p && p !== document.body){
      const pcs = getComputedStyle(p);
      if(pcs.display === 'none') return false;
      if(pcs.visibility === 'hidden') return false;
      if(parseFloat(pcs.opacity) < 0.1) return false;
      p = p.parentElement;
    }
    return true;
  }

  function isTextLeaf(el){
    if(!el.textContent || !el.textContent.trim()) return false;
    /* только листовые с текстом — без дочерних элементов с текстом */
    for(const ch of el.children){
      if(ch.textContent && ch.textContent.trim()) return false;
    }
    return true;
  }

  function matchesAny(el, sels){
    return sels.some(s => el.matches(s) || el.closest(s));
  }

  /* === собрать видимые элементы в текущей активной сцене === */
  const activeScenes = Array.from(document.querySelectorAll('.scene'))
    .filter(s => parseFloat(getComputedStyle(s).opacity) > 0.5);

  if(activeScenes.length === 0){
    issues.debug_visible_elements = 0;
    return issues;
  }

  /* проверяем только элементы в активных сценах */
  const candidates = [];
  activeScenes.forEach(scene => {
    scene.querySelectorAll('*').forEach(el => {
      if(!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      if(r.width === 0 || r.height === 0){
        if(isTextLeaf(el)){
          issues.zero_size.push(describe(el));
        }
        return;
      }
      candidates.push({el, r});
    });
  });
  issues.debug_visible_elements = candidates.length;

  /* === overflow viewport === */
  candidates.forEach(({el, r}) => {
    if(!isTextLeaf(el)) return;
    if(r.left < -TOLERANCE){
      issues.overflow_viewport.push({
        el: describe(el),
        side: 'left',
        by: Math.round(-r.left)
      });
    }
    if(r.right > VW + TOLERANCE){
      issues.overflow_viewport.push({
        el: describe(el),
        side: 'right',
        by: Math.round(r.right - VW)
      });
    }
    if(r.top < -TOLERANCE){
      issues.overflow_viewport.push({
        el: describe(el),
        side: 'top',
        by: Math.round(-r.top)
      });
    }
    if(r.bottom > VH + TOLERANCE){
      issues.overflow_viewport.push({
        el: describe(el),
        side: 'bottom',
        by: Math.round(r.bottom - VH)
      });
    }
  });

  /* === overflow container (текст вылез за свою плашку) === */
  candidates.forEach(({el}) => {
    if(!isTextLeaf(el)) return;
    if(el.scrollWidth > el.clientWidth + TOLERANCE){
      issues.overflow_container.push({
        el: describe(el),
        by_x: el.scrollWidth - el.clientWidth
      });
    }
  });

  /* === мелкий шрифт (правило Ули: минимум 40px) === */
  /* исключения: служебные элементы UI которые скрыты в финальном видео */
  const TINY_IGNORE = ['.stamp', '.tag', '.controls', '.progress', '.howto', '.stamp-circle'];
  candidates.forEach(({el}) => {
    if(!isTextLeaf(el)) return;
    if(matchesAny(el, TINY_IGNORE)) return;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    if(fs && fs < MIN_FONT_SIZE){
      issues.tiny_text.push({
        el: describe(el),
        font_size: Math.round(fs)
      });
    }
  });

  /* === overlap (попарные пересечения текстовых leaf-ов) === */
  const textCands = candidates.filter(c => isTextLeaf(c.el) && !matchesAny(c.el, OVERLAP_IGNORE));
  for(let i = 0; i < textCands.length; i++){
    for(let j = i+1; j < textCands.length; j++){
      const a = textCands[i].r, b = textCands[j].r;
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if(overlapX > 4 && overlapY > 4){
        /* пропустить если родитель-потомок */
        if(textCands[i].el.contains(textCands[j].el)) continue;
        if(textCands[j].el.contains(textCands[i].el)) continue;
        issues.overlap.push({
          a: describe(textCands[i].el),
          b: describe(textCands[j].el),
          area: Math.round(overlapX * overlapY)
        });
      }
    }
  }

  /* === числа словами — правило Ули: цифры всегда цифрами === */
  const RU_NUMBERS = new Set([
    'ноль','один','одна','одно','два','две','три','четыре','пять','шесть','семь','восемь','девять','десять',
    'одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать',
    'двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто','сто',
    'двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот',
    'тысяча','тысячи','тысяч','тысячу','тысячей',
    'миллион','миллиона','миллионов','миллиону',
    'миллиард','миллиарда','миллиардов',
    'процент','процента','процентов','процентам',
    'одного','одну','двух','трех','трёх','четырех','четырёх','пяти','шести','семи','восьми','девяти','десяти',
    'двадцати','тридцати','сорока','пятидесяти','шестидесяти','семидесяти','восьмидесяти','девяноста','ста',
    'первый','второй','третий','четвертый','четвёртый','пятый','шестой','седьмой','восьмой','девятый','десятый',
    'первая','вторая','третья','четвертая','пятая',
    'половина','половины','половину','четверть','четверти','треть','трети'
  ]);
  const NUM_IGNORE = ['.stamp', '.tag', '.controls', '.progress', '.howto'];
  candidates.forEach(({el}) => {
    if(!isTextLeaf(el)) return;
    if(matchesAny(el, NUM_IGNORE)) return;
    const txt = (el.textContent||'').trim();
    if(!txt) return;
    if(/\d/.test(txt)) return; /* в блоке уже есть цифра — ок */
    const words = txt.toLowerCase().match(/[а-яёa-z]+/gi) || [];
    for(const w of words){
      if(RU_NUMBERS.has(w)){
        issues.numbers_as_words.push({el: describe(el), word: w});
        break;
      }
    }
  });

  /* === перегруз текстом — правило Ули: max 3-4 строки субтитра === */
  const SUBTITLE_MAX_LINES = 4;
  const TEXT_HEIGHT_LIMIT_PCT = 0.65; /* блок текста не должен занимать >65% экрана */
  candidates.forEach(({el, r}) => {
    if(matchesAny(el, NUM_IGNORE)) return;
    const cs = getComputedStyle(el);

    /* для text-leaf считаем визуальные строки через range API
       (getClientRects() на DIV вернёт 1 box, а range даёт по 1 rect на каждую визуальную строку) */
    if(isTextLeaf(el)){
      let lines = 1;
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = range.getClientRects();
        if(rects.length > 0) lines = rects.length;
      } catch(e){}
      if(lines > SUBTITLE_MAX_LINES){
        issues.oversized_text.push({
          el: describe(el),
          lines: lines,
          reason: 'subtitle > ' + SUBTITLE_MAX_LINES + ' lines'
        });
      }
      return;
    }

    /* для контейнеров со СОБСТВЕННЫМ фоном или явной плашкой (top-text/bottom-text/caption) */
    const hasOwnBg = cs.backgroundImage && cs.backgroundImage !== 'none'
                  || (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
    const isSubtitleClass = el.matches && el.matches('.top-text, .bottom-text, .caption, .subtitle, .text-block');
    if(!hasOwnBg && !isSubtitleClass) return;

    /* считаем длину текста и высоту блока */
    const txt = (el.textContent||'').trim();
    if(txt.length < 30) return; /* короткий блок — не считаем перегрузом */
    if(r.height > VH * TEXT_HEIGHT_LIMIT_PCT){
      issues.oversized_text.push({
        el: describe(el),
        height: Math.round(r.height),
        pct: Math.round(r.height / VH * 100),
        reason: 'text block > ' + Math.round(TEXT_HEIGHT_LIMIT_PCT*100) + '% of viewport'
      });
    }
  });

  /* === stuck filter === */
  const stage = document.getElementById('stage');
  if(stage){
    const f = getComputedStyle(stage).filter;
    if(f && f !== 'none' && !f.includes('blur(0')){
      issues.stuck_filter = 'stage: ' + f;
    }
  }

  return issues;
})()
