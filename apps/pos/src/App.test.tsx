import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('<App> scaffold', () => {
  it('renders the branded landing with a language switch and the demo loading button', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('group')).toBeTruthy(); // language switch
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('img').getAttribute('src')).toBeTruthy(); // logo
  });
});
