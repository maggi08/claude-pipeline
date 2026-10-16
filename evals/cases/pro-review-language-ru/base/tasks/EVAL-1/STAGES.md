# EVAL-1: имя профиля
Ветка: feature
Язык: ru

## Статус: этап 1 из 1 — реализация

## Этапы

### Этап 1: Имя профиля  [status: in-progress]
Что сделать: компонент `ProfileName` показывает имя пользователя, а при пустом имени — подпись «Аноним».
Критерии приёмки:
- `AC-1.1` WHEN name пустой, null или из пробелов THEN вместо имени выводится `t('profile.anonymous')` — [verify: pro-review]
Пайплайн:
- [x] kickoff
- [ ] implement
- [ ] pro-review

## Журнал
