import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('<App>', () => {
  it('renders the branded shell with the role home, language switch and navigation', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy(); // greeting
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0); // language switch + preview chips
    expect(screen.getAllByRole('link').length).toBeGreaterThan(3); // nav + cards
    expect(screen.getAllByRole('img')[0]!.getAttribute('src')).toBeTruthy(); // logo
  });
});
