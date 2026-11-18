import type { Entity, User } from './shared/contracts.js';
import { emptyState, type DatabaseState } from './repository.js';

export function createSeed(now = new Date()): DatabaseState {
  const state = emptyState();
  const date = (offset: number) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString(); };
  state.tags = ['Походы', 'Выживание', 'Спорт', 'Книги', 'Бег', 'Горы', 'Фотография', 'Волонтёрство', 'Рыбалка', 'Велосипед'].map((name, i) => ({ id: `tag-${i + 1}`, name }));
  state.items = ['Палатка', 'Аптечка', 'Горелка', 'Котелок', 'Рация', 'Тент', 'Фильтр для воды'].map((name, i) => ({ id: `item-${i + 1}`, name }));
  const cities = [
    ['Москва', 'Россия', 55.75, 37.62], ['Санкт-Петербург', 'Россия', 59.93, 30.34], ['Казань', 'Россия', 55.8, 49.1],
    ['Минск', 'Беларусь', 53.9, 27.57], ['Тбилиси', 'Грузия', 41.72, 44.78], ['Алматы', 'Казахстан', 43.24, 76.89],
    ['Екатеринбург', 'Россия', 56.84, 60.6], ['Краснодар', 'Россия', 45.04, 38.98], ['Берлин', 'Германия', 52.52, 13.4],
    ['Лиссабон', 'Португалия', 38.72, -9.14], ['Новосибирск', 'Россия', 55.0, 82.93], ['Стамбул', 'Турция', 41.01, 28.98],
  ] as const;
  const names = ['Александр Волков', 'Михаил Соколов', 'Дмитрий Орлов', 'Артём Лесной', 'Иван Северин', 'Сергей Громов', 'Максим Кедров', 'Андрей Миронов', 'Никита Фролов', 'Павел Ветров', 'Олег Белов', 'Роман Смирнов', 'Егор Кузнецов', 'Вадим Рощин', 'Денис Савин', 'Антон Морозов', 'Виктор Корнев', 'Лев Тихонов', 'Константин Руднев', 'Глеб Крылов', 'Владимир Седов', 'Тимур Рахимов', 'Алексей Логинов', 'Борис Яров'];
  const colors = ['#ce6b2c', '#79927d', '#728eaa', '#b58d51', '#9a797d', '#628e89'];
  state.users = names.map((name, i): User => {
    const city = cities[i % cities.length]!;
    return { id: `user-${i + 1}`, name, username: `klan_member_${i + 1}`, role: i === 0 ? 'admin' : 'member',
      bio: ['Хожу в горы, учусь новому и собираю рядом людей, на которых можно положиться.', 'Люблю длинные маршруты, честные разговоры у костра и хорошие книги.', 'Бегаю по утрам. По выходным меня можно найти в лесу с рюкзаком.'][i % 3]!,
      location: { city: city[0], country: city[1], lat: city[2], lng: city[3] },
      tags: [state.tags[i % state.tags.length]!, state.tags[(i + 2) % state.tags.length]!, state.tags[(i + 4) % state.tags.length]!],
      initials: name.split(' ').map(word => word[0]).join(''), color: colors[i % colors.length]!,
      facts: ['В сообществе с 2024 года', `${2 + i} самостоятельных походов`], interests: [state.tags[i % state.tags.length]!.name],
      achievements: i % 3 === 0 ? ['Первый перевал', '30 дней движения'] : ['Первый маршрут'],
      stats: { events: 0, challenges: 0, books: 0 }, joinedAt: date(-300 + i * 5) };
  });
  const participants = (count: number, offset = 0) => state.users.slice(offset, offset + count).map(user => ({ user }));
  const base = (id: string, type: Entity['type'], title: string, description: string): Entity => ({ id, type, title, description, status: 'active', category: '', tags: [state.tags[0]!], createdAt: date(-10), participants: [] });
  const eventData = [
    ['event-1', 'Тропа за горизонт', 'Два дня в лесу. Без городского шума, с рюкзаком и своими людьми. Маршрут 24 км, ночёвка под звёздами.', 'offline', 4, 'Подмосковье', 12],
    ['event-2', 'Утренний круг', 'Открытая совместная пробежка. Темп разговорный, дистанция 5–10 км. Встречаемся у входа в парк.', 'offline', 2, 'Москва', 8],
    ['event-3', 'Разговор у костра: первая помощь', 'Практическая встреча с инструктором: как собрать аптечку и действовать до приезда помощи.', 'online', 7, 'Онлайн', 18],
    ['event-4', 'Выход на скалы', 'Тренируем страховку и работаем в связке. Всё необходимое снаряжение обсудим заранее.', 'offline', 12, 'Екатеринбург', 6],
    ['event-5', 'Лесной субботник', 'Пройдём любимый маршрут, соберём мусор и заварим чай на финише.', 'offline', 9, 'Казань', 10],
    ['event-6', 'Книжный клуб: сила привычки', 'Обсуждаем идеи, которые можно применить уже завтра. Достаточно прочитать первые три главы.', 'online', 14, 'Онлайн', 7],
  ] as const;
  for (const [id, title, description, category, offset, city, count] of eventData) {
    state.entities.push({ ...base(id, 'events', title, description), category, schedule: { start: date(offset), end: date(offset + 1) }, location: { city, country: 'Россия', lat: 55.75, lng: 37.62 }, capacity: 30, participants: participants(count), content: 'Собираемся за 15 минут до старта. Возьмите воду, удобную одежду и хорошее настроение. Детали и общий список снаряжения — ниже.' });
  }
  const firstEvent = state.entities.find(entity => entity.id === 'event-1')!;
  firstEvent.participants[0]!.items = [{ ...state.items[0]!, quantity: 1 }, { ...state.items[4]!, quantity: 2 }];
  firstEvent.participants[1]!.items = [{ ...state.items[1]!, quantity: 1 }];
  firstEvent.participants[2]!.items = [{ ...state.items[2]!, quantity: 1 }, { ...state.items[3]!, quantity: 1 }];
  state.entities.push(
    { ...base('team-1', 'teams', 'Северный ветер', 'Команда тех, кто выбирает путь посложнее. Ходим в горы, поддерживаем друг друга и держим слово.'), motto: 'Дальше вместе.', participants: participants(6), tags: [state.tags[0]!, state.tags[5]!] },
    { ...base('team-2', 'teams', 'Лесной дозор', 'Исследуем маршруты выходного дня и учимся жить в гармонии с природой.'), motto: 'Лес знает своих.', participants: participants(5, 6), tags: [state.tags[1]!] },
    { ...base('team-3', 'teams', 'На характере', 'Бег, турники, дисциплина. Маленький шаг каждый день превращается в большой результат.'), motto: 'Ни дня без движения.', participants: participants(7, 11), tags: [state.tags[2]!, state.tags[4]!] },
    { ...base('team-4', 'teams', 'Высота 2025', 'Команда летнего похода на Кавказ. Сохраняем историю и возвращаемся к воспоминаниям.'), status: 'archived', motto: 'Выше только небо.', participants: participants(4, 3) },
  );
  const challenge = { ...base('challenge-1', 'challenges', '30 дней движения', 'Каждый день — шаг вперёд. Приседания, отжимания и личная дисциплина. Собираем результат вместе.'), category: 'sport', schedule: { start: date(-10), end: date(20) }, goal: { target: 3000, unit: 'повторений' }, participants: participants(16), results: [] } as Entity;
  challenge.participants = challenge.participants.map((participant, i) => {
    const team = state.entities.find(entity => entity.type === 'teams' && entity.status === 'active' && entity.participants.some(p => p.user.id === participant.user.id));
    return team && i % 4 !== 3 ? { ...participant, team: { id: team.id, title: team.title } } : participant;
  });
  challenge.results = state.users.slice(0, 12).flatMap((user, i) => [-2, -1, 0].map(offset => ({ user, date: date(offset).slice(0, 10), value: 40 + i * 9, team: challenge.participants.find(p => p.user.id === user.id)?.team })));
  state.entities.push(challenge,
    { ...base('challenge-2', 'challenges', '100 километров к себе', 'Месяц пеших прогулок и пробежек. Зачёт идёт на километры. Участвовать можно соло или своей командой.'), category: 'distance', schedule: { start: date(-5), end: date(25) }, goal: { target: 100, unit: 'км' }, participants: participants(9, 5), results: [] },
    { ...base('challenge-3', 'challenges', 'Сильное утро', 'Отмечай дни, когда выполнил утреннюю зарядку. Один день — одна отметка.'), category: 'attendance', schedule: { start: date(-3), end: date(27) }, goal: { target: 30, unit: 'дней' }, participants: participants(8, 2), results: [] },
  );
  state.entities.push(
    { ...base('news-1', 'news', 'Новый сезон. Новые маршруты.', 'Открываем запись на осенние походы и собираем команды. В этом месяце нас ждут лесные тропы, совместные тренировки и встречи.'), category: 'community', author: state.users[0], content: 'Сообщество начинается с простого: выйти из дома и познакомиться. Мы подготовили маршруты разной сложности, чтобы каждый нашёл свой темп.\n\nВыберите мероприятие, отметьте участие и расскажите, что возьмёте с собой. Вместе идти легче.' },
    { ...base('news-2', 'news', 'Разные города — одно сообщество', 'Наши участники встречаются по всему миру. Найдите своих рядом на карте сообщества.'), category: 'community', author: state.users[0], content: 'Укажите город и интересы в профиле. Так люди рядом смогут найти вас и предложить совместный маршрут.' },
    { ...base('feedback-1', 'feedback', 'Добавить маршруты выходного дня', 'Предлагаю собрать проверенные маршруты в пределах двух часов от города.'), status: 'in_progress', category: 'suggestion', author: state.users[3] },
    { ...base('feedback-2', 'feedback', 'Встречи для новичков', 'Было бы здорово раз в месяц проводить небольшую встречу для тех, кто только присоединился.'), status: 'open', category: 'suggestion', author: state.users[1] },
  );
  const books = [
    ['book-1', 'Атомные привычки', 'Джеймс Клир', 'Как маленькие ежедневные действия приводят к большим переменам. Практический подход к полезным привычкам.'],
    ['book-2', 'В диких условиях', 'Джон Кракауэр', 'История поиска свободы, испытания одиночеством и силы природы. Книга для разговора о границах риска.'],
    ['book-3', 'Сила воли', 'Келли Макгонигал', 'Почему мы принимаем решения и что помогает следовать собственным намерениям.'],
    ['book-4', 'Человек в поисках смысла', 'Виктор Франкл', 'О внутренней свободе, ответственности и способности сохранять смысл в самых трудных обстоятельствах.'],
  ] as const;
  for (const [id, title, author, description] of books) state.entities.push({ ...base(id, 'books', title, description), category: author, readers: state.users.slice(0, 5 + Number(id.slice(-1))), tags: [state.tags[3]!] });
  const rules = [
    ['rule-1', 'Кодекс сообщества', 'general', 'Уважай людей. Держи слово. Поддерживай тех, кто рядом.\n\nНе публикуй чужие личные данные. Спорь с идеей, а не с человеком. Реклама и спам без согласования запрещены.\n\nКаждый отвечает за свои действия, а сообщество помогает стать сильнее.'],
    ['rule-2', 'Правила офлайн-встреч', 'offline', 'Оценивай свои силы и подготовку. Сообщай организатору об ограничениях заранее.\n\nНе отходи от группы без предупреждения. Соблюдай местные правила и береги природу. Оставляй место чище, чем оно было.'],
    ['rule-3', 'Правила онлайн-встреч', 'online', 'Приходи вовремя, проверяй связь и выключай микрофон, когда не говоришь.\n\nНе записывай и не публикуй встречу без согласия участников.'],
    ['rule-4', 'Рекомендации новичку', 'recommendations', 'Заполни профиль, укажи город и интересы. Найди участников рядом.\n\nНачни с доступного мероприятия, задавай вопросы и знакомься с людьми. Сложные маршруты оставь до подходящей подготовки.'],
  ] as const;
  for (const [id, title, category, content] of rules) state.entities.push({ ...base(id, 'rules', title, content.split('\n')[0]!), category, content });
  state.activities = [
    ['присоединился к команде', 'team-1'], ['записался на мероприятие', 'event-1'], ['добавил результат в челлендж', 'challenge-1'], ['прочитал книгу', 'book-1'], ['обновил профиль', ''], ['записался на мероприятие', 'event-3'], ['присоединился к команде', 'team-2'],
  ].map(([action, targetId], i) => {
    const user = state.users[i + 1]!; const target = state.entities.find(entity => entity.id === targetId);
    return { id: `activity-${i + 1}`, actor: { id: user.id, name: user.name, role: user.role, initials: user.initials, color: user.color }, action: action!, target: target ? { title: target.title, path: `/${target.type}/${target.id}` } : undefined, createdAt: new Date(now.getTime() - (i * 18 + 3) * 60000).toISOString() };
  });
  return state;
}
