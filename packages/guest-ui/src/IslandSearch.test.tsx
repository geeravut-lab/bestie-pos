import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { IslandShop } from '@bestie/core';
import { I18nProvider } from '@bestie/i18n';
import { IslandShops } from './IslandShops';

afterEach(cleanup);
const shops: IslandShop[] = [
  {
    category: 'food',
    title: { th: 'ครัวทะเล', en: 'Sea Kitchen' },
    about: { en: 'Fresh grilled fish' },
    bookingToken: null,
    orderToken: 'a'.repeat(32),
  },
  {
    category: 'spa',
    title: { th: 'สปาป่า', en: 'Jungle Spa' },
    about: { en: 'Thai massage' },
    bookingToken: 'b'.repeat(32),
    orderToken: null,
  },
  {
    category: 'tour',
    title: { th: 'ทัวร์เกาะ', en: 'Island Tours' },
    about: null,
    bookingToken: null,
    orderToken: null,
  },
];
const mount = () =>
  render(
    <I18nProvider guest initialLang="en">
      <IslandShops shops={shops} />
    </I18nProvider>,
  );

describe('<IslandShops> search and ordering', () => {
  it('finds a shop by a word of its name, its description or its category', async () => {
    mount();
    const box = screen.getByRole('searchbox', { name: 'Search shops' });
    await userEvent.type(box, 'grilled');
    expect(screen.getByText('Sea Kitchen')).toBeTruthy();
    expect(screen.queryByText('Jungle Spa')).toBeNull();
    await userEvent.clear(box);
    await userEvent.type(box, 'MASSAGE');
    expect(screen.getByText('Jungle Spa')).toBeTruthy();
    expect(screen.queryByText('Sea Kitchen')).toBeNull();
    await userEvent.clear(box);
    await userEvent.type(box, 'ทัวร์');
    expect(screen.getByText('Island Tours')).toBeTruthy();
  });
  it('says so when nothing matches', async () => {
    mount();
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText('No shop matches your search.')).toBeTruthy();
  });
  it('offers Order food only to a shop with an online-order page, and Book only to one with booking', () => {
    mount();
    const order = screen.getAllByRole('link', { name: 'Order food' });
    expect(order).toHaveLength(1);
    expect(order[0]!.getAttribute('href')).toBe(`/t/${'a'.repeat(32)}`);
    expect(screen.getAllByRole('link', { name: /Book/ })).toHaveLength(1);
  });
});
