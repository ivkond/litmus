# Prompt: Litmus Leaderboard Report Generator

## Роль

Ты — аналитик, генерирующий HTML-отчёт «Leaderboard» по результатам бенчмарка Litmus.
Отчёт предназначен для руководителя. Стиль: строгий аналитический документ с элементами дашборда и информативной визуализацией. Без AI-slop (градиентов, свечений, анимаций, emoji).

---

## Входные данные

На вход подаётся путь к директории прогона: `results/<RUN_ID>/`

### Структура директории прогона

```
results/<RUN_ID>/
├── report.html                          # Сводная таблица (Agent/Model × Scenario)
├── analysis.json                        # Агрегированные оценки по агентам и моделям
├── analysis.html                        # Детальный HTML-анализ
├── <Agent>_<model_slug>/               # Директория результатов конкретной пары agent+model
│   ├── evaluation.json                  # 20 agent_scores + 20 model_scores + task_scores
│   ├── report.html                      # Пошаговый отчёт агента
│   └── <scenario_name>/
│       ├── steps.json                   # Шаги выполнения с таймингами
│       ├── 01_sync.log ... NN_*.log     # Логи шагов
│       └── workdir/                     # Результат работы агента
```

### Ключевые файлы данных

#### steps.json — массив шагов выполнения сценария
```json
[
  {
    "name": "Project init (uv sync)",
    "log_file": "01_sync.log",
    "status": "done",           // "done" | "failed"
    "start_iso": "14:10:12",
    "end_iso": "14:10:12",
    "elapsed": 0.2              // секунды
  },
  {
    "name": "Agent call (testing/moonshotai/Kimi-K2.5)",
    "log_file": "02_agent.log",
    "status": "done",
    "elapsed": 17.0
  }
]
```

#### evaluation.json — оценки по 40 критериям + задачам
```json
{
  "agent_scores": {
    "<criterion>": { "score": 1-10, "rationale": "..." }
    // 20 критериев: tool_efficiency, reasoning_verbosity, thinking_depth,
    // error_recovery, context_utilization, file_operation_accuracy,
    // retry_strategy, output_formatting, task_decomposition,
    // dependency_management, test_awareness, code_generation_quality,
    // prompt_interpretation, execution_speed, side_effect_awareness,
    // idempotency, progress_communication, resource_efficiency,
    // graceful_degradation, final_state_correctness
  },
  "agent_summary": "Текстовое резюме по агенту",
  "model_scores": {
    "<criterion>": { "score": 1-10, "rationale": "..." }
    // 20 критериев: reasoning_correctness, tool_call_formation,
    // code_correctness, instruction_following, hallucination_resistance,
    // type_awareness, error_diagnosis, solution_completeness,
    // code_style_consistency, api_knowledge_accuracy, edge_case_handling,
    // architecture_understanding, import_correctness, test_understanding,
    // debugging_strategy, natural_language_clarity, self_correction_ability,
    // context_window_usage, output_structure, domain_knowledge
  },
  "model_summary": "Текстовое резюме по модели",
  "task_scores": {
    "<scenario_name>": {
      "criteria": {
        "<criterion_text>": { "met": true/false, "comment": "..." }
      },
      "total_score": 10,
      "max_score": 10
    }
  }
}
```

#### analysis.json — агрегированные оценки (по агентам и моделям через все пары)
```json
{
  "agents": {
    "<AgentName>": {
      "scores": { "<criterion>": { "score": N, "rationale": "..." } },
      "summary": "..."
    }
  },
  "models": {
    "<model_id>": {
      "scores": { "<criterion>": { "score": N, "rationale": "..." } },
      "summary": "..."
    }
  }
}
```

#### report.html — сводная таблица со статусами и таймингами
Каждая ячейка содержит:
- Статус: `OK` (тесты прошли с 1 попытки), `Warn` (прошли после retry), `Fail` (не прошли)
- Время выполнения в секундах

### Сценарии (8 штук)

| # | Сценарий | Что проверяет |
|---|----------|---------------|
| 1 | data-structure | Реализация структуры данных (TimeBasedKeyValueStore, bisect, O(log n)) |
| 2 | simple-architecture | REST API на FastAPI с Pydantic валидацией |
| 3 | complex-debug | Исправление бага thread-safety (threading.Lock) |
| 4 | spec-compliance | Точное следование спецификации (frozen dataclass, формулы, edge cases) |
| 5 | hallucination | Устойчивость к ошибке в промпте (mathplotlib → matplotlib) |
| 6 | tool-calling | Корректное использование инструментов (создание файла через tool calls) |
| 7 | architecture-design | Проектирование архитектуры кэша для 100k RPS (только текст) |
| 8 | long-context | Поиск токена в длинном файле |

---

## Выходной формат

Один self-contained HTML-файл. Никаких внешних зависимостей (CDN, шрифты, JS-библиотеки).

---

## Структура отчёта

### 1. Заголовок и метаданные
- Название: «Litmus Benchmark — Leaderboard»
- Дата прогона, дата генерации отчёта
- Run ID

### 2. Итоговый Leaderboard (таблица-рейтинг)

Основная таблица, отсортированная по убыванию общего балла.

| Поз. | Модель | Агент | Сценарии (OK/Warn/Fail) | Средний балл задач | Средний балл модели | Средний балл агента | Общее время | Общий рейтинг |
|------|--------|-------|------------------------|--------------------|--------------------|--------------------|-----------|----|

- **Сценарии** — компактная визуализация 8 ячеек: зелёная/оранжевая/красная точка или квадрат
- **Общий рейтинг** — взвешенный балл: `task_score * 0.5 + model_score * 0.3 + agent_score * 0.2` (нормализованные к 10)
- Позиция 1 выделена визуально (жирнее, фон строки чуть темнее)

### 3. KPI-карточки (топ-4 метрики)

Четыре карточки в ряд:
- **Лучшая модель** — имя и общий балл
- **Лучший агент** — имя и общий балл
- **Среднее время сценария** — по всем парам
- **Pass Rate** — % сценариев со статусом OK или Warn из общего числа

### 4. Сравнение по сценариям (горизонтальные бары)

Для каждого сценария — горизонтальная полоса для каждой пары model+agent, длина пропорциональна баллу (0-10). Цвет по баллу: зелёный ≥8, оранжевый ≥5, красный <5. Рядом — время в секундах.

### 5. Скорость работы (таблица таймингов)

| Модель | Агент | Сц.1 | Сц.2 | ... | Сц.8 | Всего | Среднее | Медиана | Retry-ы |
|--------|-------|------|------|-----|------|-------|---------|---------|---------|

- Время = elapsed из steps.json (сумма по шагам сценария)
- Retry-ы = количество шагов с именем "Agent retry" в steps.json
- Подсветить самое быстрое время в каждом столбце (зелёный фон)
- Подсветить самое медленное (красный фон)

### 6. Оценки модели (radar-like таблица)

Тепловая карта по 20 model_scores критериям. Строки = модели, столбцы = критерии.
Цвет ячейки: градация от красного (1-3) через оранжевый (4-6) к зелёному (7-10).
Число в ячейке. Tooltip с rationale.

### 7. Оценки агента (аналогичная тепловая карта)

Тепловая карта по 20 agent_scores критериям. Строки = агенты, столбцы = критерии.

### 8. Детали по ключевым сценариям

Для каждого из 8 сценариев — раскрываемый блок (`<details>`):
- Описание сценария (1-2 предложения из таблицы выше)
- Таблица результатов по парам model+agent:
  - Статус (OK/Warn/Fail)
  - Балл задачи (X/10)
  - Количество шагов
  - Время
  - Количество retry
- Список критериев приёмки с результатами (met/not met) из task_scores

### 9. Резюме и выводы

На основе данных — 3-5 пунктов:
- Какая модель лидирует и почему
- Ключевые сильные/слабые стороны лидера
- Какие сценарии оказались самыми сложными
- Рекомендация (какую модель использовать)

---

## Визуальный стиль

### Тема: светлая, строгая

```css
:root {
  --bg: #ffffff;
  --surface: #f8f9fa;
  --surface-alt: #f1f3f5;
  --border: #dee2e6;
  --text: #212529;
  --text-secondary: #495057;
  --muted: #868e96;

  --ok: #2b8a3e;
  --ok-bg: #ebfbee;
  --warn: #e67700;
  --warn-bg: #fff9db;
  --fail: #c92a2a;
  --fail-bg: #fff5f5;

  --accent: #1864ab;
  --accent-bg: #e7f5ff;
}
```

### Типографика
- Основной шрифт: `"Segoe UI", system-ui, -apple-system, sans-serif`
- Моноширинный: `"Cascadia Code", "JetBrains Mono", "Fira Code", monospace`
- Заголовок h1: 1.5rem, font-weight: 700
- Заголовок h2: 1.15rem, font-weight: 600, border-bottom: 2px solid var(--border)
- Размер основного текста: 0.875rem
- Line-height: 1.5

### Таблицы
- border-collapse: collapse
- Заголовки: фон var(--surface-alt), цвет var(--text-secondary), font-weight: 600, text-transform: uppercase, font-size: 0.75rem, letter-spacing: 0.04em
- Ячейки: padding 0.5rem 0.75rem, border-bottom: 1px solid var(--border)
- Строки: чередование фона нет (чистый белый)
- Первый столбец: font-weight: 500, white-space: nowrap

### KPI-карточки
- Белый фон, border: 1px solid var(--border), border-radius: 6px
- Padding: 1rem 1.25rem
- Значение: font-size: 1.75rem, font-weight: 700, color: var(--text)
- Подпись: font-size: 0.8rem, color: var(--muted), text-transform: uppercase, letter-spacing: 0.04em

### Бейджи (статусы)
```css
.badge       { padding: 0.15em 0.5em; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
.badge.ok    { background: var(--ok-bg); color: var(--ok); }
.badge.warn  { background: var(--warn-bg); color: var(--warn); }
.badge.fail  { background: var(--fail-bg); color: var(--fail); }
```

### Горизонтальные бары
- Контейнер: высота 1.25rem, фон var(--surface), border-radius: 3px
- Бар: border-radius: 3px, min-width для отображения числа
- Подпись справа от бара: font-size: 0.8rem, color: var(--muted)

### Тепловая карта
- Ячейки: min-width: 2.5rem, text-align: center, font-size: 0.8rem, font-weight: 600
- Цвета фона по значению:
  - 9-10: #ebfbee (зелёный)
  - 7-8: #d3f9d8
  - 5-6: #fff9db (оранжевый)
  - 3-4: #ffe8cc
  - 1-2: #fff5f5 (красный)
- Цвет текста по значению:
  - ≥7: var(--ok)
  - 5-6: var(--warn)
  - ≤4: var(--fail)

### Раскрываемые блоки
```css
details { border: 1px solid var(--border); border-radius: 6px; margin: 0.75rem 0; }
summary { padding: 0.75rem 1rem; cursor: pointer; font-weight: 500; }
summary:hover { background: var(--surface); }
details[open] summary { border-bottom: 1px solid var(--border); }
details > div { padding: 1rem; }
```

---

## CSS для печати / PDF

```css
@media print {
  body { padding: 0; font-size: 10pt; }
  @page { size: A4 landscape; margin: 1.5cm; }

  /* Разрывы страниц */
  h2 { page-break-before: auto; page-break-after: avoid; }
  table, .kpi-grid { page-break-inside: avoid; }
  details { page-break-inside: avoid; }
  details[open] { break-inside: auto; }

  /* Раскрыть все details */
  details { border: 1px solid #ccc; }
  details > summary { display: none; }
  details > div, details > table { display: block !important; }

  /* Убрать интерактив */
  .score-cell[data-tip]:hover::after { display: none; }

  /* Фон для тепловой карты оставить */
  .heatmap td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar-fill { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .kpi-value { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
```

---

## Алгоритм сборки данных

```
1. Прочитать results/<RUN_ID>/report.html
   → Распарсить таблицу: для каждой пары agent+model → статус и время по сценариям

2. Прочитать results/<RUN_ID>/analysis.json
   → Агрегированные оценки по агентам и моделям (20 критериев каждый)

3. Для каждой поддиректории <Agent>_<model_slug>/:
   a. Прочитать evaluation.json → agent_scores, model_scores, task_scores
   b. Для каждого сценария прочитать steps.json:
      → Подсчитать: общее время, число шагов, число retry (шаги с "retry" в имени)
      → Извлечь: время агентского вызова (шаг "Agent call"), время тестов

4. Агрегировать:
   - task_avg = среднее task_scores[*].total_score / max_score * 10
   - model_avg = среднее model_scores[*].score
   - agent_avg = среднее agent_scores[*].score
   - overall = task_avg * 0.5 + model_avg * 0.3 + agent_avg * 0.2
   - pass_rate = количество OK+Warn / общее количество сценариев
   - total_time = сумма elapsed по всем шагам всех сценариев

5. Отсортировать по overall desc → позиция в leaderboard
```

---

## Форматирование данных

- Время: `XX.Xs` (одна десятичная). Для суммарного: `X мин YY сек` если > 60s
- Баллы: одна десятичная (7.2/10)
- Проценты: целые (87%)
- Имя модели: человекочитаемое. Slug `testing~fmoonshotai~fKimi-K2.5` → `moonshotai/Kimi-K2.5` (заменить `~f` на `/`, убрать провайдер-префикс `testing/`)
- Имя агента: первая часть до `_` в имени директории (KiloCode, OpenCode)

---

## Чего НЕ делать

- Не использовать CDN, Google Fonts, внешние ресурсы
- Не добавлять JavaScript кроме минимального для `<details>` (которые работают нативно)
- Не использовать градиенты, тени box-shadow глубже 2px, анимации, emoji
- Не округлять углы больше 6px
- Не использовать цветные заголовки — только var(--text)
- Не добавлять «Generated by AI» или подобные дисклеймеры
- Не выдумывать данные — только то, что есть в файлах

---

## Пример вызова

```
Сгенерируй leaderboard-отчёт для прогона results/20260325_140531/
```

Ожидаемый результат: файл `docs/leaderboard-<RUN_ID>.html`
