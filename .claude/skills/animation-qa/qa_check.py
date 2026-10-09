#!/usr/bin/env python3
"""
qa_check.py — автопроверка HTML-анимации.

Запуск:
    python3 ~/.claude/skills/animation-qa/qa_check.py /путь/к/index.html

Что делает:
    1. Открывает HTML в headless Chromium 1080×1920
    2. Запускает window.startAnimation() в QA-режиме (?qa=1)
    3. Дёргает master.seek() в середину каждой сцены
    4. Делает скриншот + инжектит qa_inject.js для проверок
    5. Печатает JSON-отчёт в stdout

Требования к HTML:
    - window.startAnimation() — запускает анимацию
    - window.master — anime.timeline (доступен после startAnimation)
    - window.qaTimepoints — массив [{scene:N, t:ms}] (заполняется самой анимацией)
"""

import asyncio
import json
import shutil
import sys
from pathlib import Path

INJECT_PATH = Path(__file__).parent / 'qa_inject.js'


async def run_qa(html_path: Path):
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print('[ERR] playwright не установлен. pip3 install playwright && python3 -m playwright install chromium', file=sys.stderr)
        sys.exit(1)

    html_path = html_path.resolve()
    if not html_path.exists():
        print(f'[ERR] нет файла {html_path}', file=sys.stderr)
        sys.exit(1)

    frames_dir = html_path.parent / '_qa_frames'
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir()

    inject_js = INJECT_PATH.read_text(encoding='utf-8')

    report = {
        'html': str(html_path),
        'frames_dir': str(frames_dir),
        'scenes': [],
        'errors': [],
        'console_errors': [],
        'warnings': []
    }

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(
            viewport={'width': 1080, 'height': 1920},
            device_scale_factor=1
        )
        page = await context.new_page()

        page.on('pageerror', lambda err: report['errors'].append(str(err)))
        page.on('console', lambda msg: report['console_errors'].append(
            f'[{msg.type}] {msg.text}'
        ) if msg.type == 'error' else None)

        await page.goto(f'file://{html_path}?qa=1')

        # ждём шрифты
        try:
            await page.wait_for_function('document.fonts.ready', timeout=3000)
        except Exception:
            report['warnings'].append('document.fonts.ready timeout')

        # прячем контролы/штампы/теги — на QA-скринах нужен финальный кадр без UI
        await page.evaluate("document.body.classList.add('recording')")

        # запускаем
        await page.evaluate('window.startAnimation()')

        # ждём чтобы master был доступен
        try:
            await page.wait_for_function('window.master', timeout=2000)
        except Exception:
            report['errors'].append('window.master не появился — анимация не стартовала')
            await browser.close()
            print(json.dumps(report, ensure_ascii=False, indent=2))
            sys.exit(1)

        # сразу пауза
        await page.evaluate('window.master.pause()')

        # читаем тайминги сцен — qaTimepoints должен быть заполнен после buildTimeline
        # формат: [{scene: 1, start: 0, end: 7000}, ...] — мы возьмём середину
        timepoints = await page.evaluate('''
            (() => {
                if(!window.qaTimepoints || window.qaTimepoints.length === 0) {
                    // фолбэк: делим всю длительность на N сцен поровну
                    const dur = window.master.duration;
                    const n = window.qaScenesCount || 8;
                    const step = dur / n;
                    return Array.from({length: n}, (_, i) => ({
                        scene: i + 1,
                        mid: step * (i + 0.75)
                    }));
                }
                const arr = window.qaTimepoints;
                // arr содержит [{scene, start}]; конец = start следующей
                const result = [];
                for(let i = 0; i < arr.length; i++) {
                    const start = arr[i].start;
                    const end = (i + 1 < arr.length) ? arr[i+1].start : window.master.duration;
                    // берём 75% сцены — анимация уже доиграла, но ещё не fade-out
                    result.push({
                        scene: arr[i].scene,
                        mid: start + (end - start) * 0.75
                    });
                }
                return result;
            })()
        ''')

        if not timepoints:
            report['errors'].append('не удалось получить тайминги сцен')

        # по каждой сцене: seek, ждём 200мс, инжект, скриншот
        for tp in timepoints:
            scene_n = tp['scene']
            mid = tp['mid']

            await page.evaluate(f'window.master.seek({mid})')
            # на всякий случай дёргаем reflow
            await page.evaluate('document.body.offsetHeight')
            await page.wait_for_timeout(150)

            issues = await page.evaluate(inject_js)

            shot_path = frames_dir / f'{scene_n:02d}.png'
            await page.screenshot(path=str(shot_path), full_page=False)

            report['scenes'].append({
                'scene': scene_n,
                'at_ms': round(mid),
                'screenshot': str(shot_path),
                'issues': issues
            })

        await browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))

    # коды возврата: 0 если чисто, 2 если есть проблемы
    has_issues = bool(report['errors']) or any(
        s['issues'].get('overflow_viewport') or
        s['issues'].get('overflow_container') or
        s['issues'].get('overlap') or
        s['issues'].get('stuck_filter') or
        s['issues'].get('zero_size') or
        s['issues'].get('tiny_text')
        for s in report['scenes']
    )
    sys.exit(2 if has_issues else 0)


def main():
    if len(sys.argv) < 2:
        print('USAGE: python3 qa_check.py /path/to/index.html', file=sys.stderr)
        sys.exit(1)
    html_path = Path(sys.argv[1])
    asyncio.run(run_qa(html_path))


if __name__ == '__main__':
    main()
