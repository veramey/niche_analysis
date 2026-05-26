# TenderGuru API integration

Минимальная интеграция с TenderGuru API v2.3 без внешних зависимостей. Нужен Node.js 18+.

## Что поддержано

- базовый URL: `https://www.tenderguru.ru/api2.3/export`;
- формат по умолчанию: `dtype=json`;
- `api_code` берется из переменной окружения `TENDERGURU_API_CODE`;
- поиск тендеров, карточка тендера по `id` или `tend_num`;
- карточка контрагента по `inn`, `ogrn`, `id`;
- контакты контрагента;
- произвольный GET-запрос через `--param key=value`;
- получение `api_code` по `refresh_code`.

## Настройка

```bash
cp .env.example .env
```

Заполните `.env` или экспортируйте переменные в shell:

```bash
export TENDERGURU_API_CODE="ВАШ_API_КЛЮЧ"
export TENDERGURU_REFRESH_CODE="ВАШ_REFRESH_CODE"
```

По документации TenderGuru ключ можно получить запросом:

```text
https://www.tenderguru.ru/api2.3/export?refresh_code=<ВАШ_REFRESH_CODE>&get_api_code=true&update=no
```

В CLI это:

```bash
npm run tg -- refresh-key --refresh-code "<ВАШ_REFRESH_CODE>" --update no
```

## Примеры

Справочник регионов:

```bash
npm run smoke
```

Поиск тендеров:

```bash
npm run tg -- search-tenders --kwords '"ремонт дороги"' --price1 10000000 --param f=44 --param r50=1
```

Карточка тендера:

```bash
npm run tg -- tender --id 12402324
npm run tg -- tender --tend-num 0174500001123002772
```

Контрагент:

```bash
npm run tg -- contragent --inn 7716615618
npm run tg -- contragent --ogrn 1027700132195
npm run tg -- contragent-contact --inn 7716615618
```

Произвольный запрос к `/api2.3/export`:

```bash
npm run tg -- get --param mode=contracts --param org_inn=7716615618
npm run tg -- get --param mode=kad --param inn=6671459435
```

## Использование из кода

```js
import { TenderGuruClient } from './src/tenderguru-client.js';

const client = new TenderGuruClient({
  apiCode: process.env.TENDERGURU_API_CODE,
});

const tenders = await client.searchTenders({
  kwords: '"ремонт дороги"',
  f: 44,
  r50: 1,
  price1: 10000000,
});

console.log(tenders);
```

## Основные параметры из документации

- `dtype`: `xml`, `json`, `csv`; без параметра API отдает XML.
- `api_code`: ключ для платных полей и разделов.
- `page`: страница выдачи, по документации доступна на платных тарифах.
- `kwords`: поисковая фраза.
- `kwords_minus`: исключаемые слова.
- `price1` / `price2`: диапазон цены.
- `date_start` / `date_end`: период публикации.
- `sort_by`: `by_date`, `by_date_end`, `by_price`.
- `r{номер}=1`: регион или страна в зависимости от раздела.
- `mode=regions`, `mode=cities`, `mode=cat`, `mode=eauc`: справочники.

Документация: https://www.tenderguru.ru/api/documentation
