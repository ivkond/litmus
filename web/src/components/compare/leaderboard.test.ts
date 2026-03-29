import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Leaderboard } from './leaderboard';

describe('Leaderboard', () => {
  it('shows a leader marker for the top-ranked entry', () => {
    const markup = renderToStaticMarkup(React.createElement(Leaderboard, {
      entries: [
        {
          rank: 1,
          entityId: 'model-1',
          entityName: 'GPT-4o',
          avgScore: 92,
          scenarioCount: 4,
          totalScenarios: 5,
          counterpartCount: 2,
          lowCoverage: false,
        },
      ],
    }));

    expect(markup).toContain('🥇');
    expect(markup).toContain('GPT-4o');
  });

  it('shows an errors-only badge instead of a numeric score when no scored scenarios exist', () => {
    const markup = renderToStaticMarkup(React.createElement(Leaderboard, {
      entries: [
        {
          rank: 2,
          entityId: 'agent-1',
          entityName: 'Cursor',
          avgScore: 0,
          scenarioCount: 0,
          totalScenarios: 5,
          counterpartCount: 1,
          lowCoverage: false,
        },
      ],
    }));

    expect(markup).toContain('errors only');
    expect(markup).not.toContain('0%');
  });
});
