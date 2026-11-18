export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Запись не найдена');
export const forbidden = () => new HttpError(403, 'FORBIDDEN', 'Недостаточно прав');
