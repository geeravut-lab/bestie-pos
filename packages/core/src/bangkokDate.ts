/** Business date in Bangkok, whatever the tablet's own clock zone is. */
export const bangkokDate = (ms: number): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
