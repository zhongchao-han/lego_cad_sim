import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ReactThreeTest from '@react-three/test-renderer';
import React from 'react';
import { InteractivePart } from '../components/InteractivePart';
import * as useStoreFile from '../store';
import * as useLDrawPartFile from '../useLDrawPart';

// Mock dependencies
vi.mock('../store', () => {
  return {
    useStore: vi.fn(),
    useIsTargetSeekingPhase: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../useLDrawPart', () => {
  return {
    useLDrawPart: vi.fn(),
  };
});

describe('InteractivePart Component Shallow Render', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockUseStore = useStoreFile.useStore as unknown as ReturnType<typeof vi.fn>;
    mockUseStore.mockImplementation((selector: any) => {
      const state = {
        selection: { primaryId: null, allConnectedIds: [], level: 0 },
        interferenceReport: { isBlocked: false },
        missedLatchPairs: [],
        interactionPhase: 'IDLE',
        slidingTarget: null,
        selectPart: vi.fn(),
        duplicateSelected: vi.fn(),
        updateSlideOffset: vi.fn(),
        commitAxialSliding: vi.fn(),
        showPortGizmos: true,
      };
      return selector(state);
    });

    const mockUseLDrawPart = useLDrawPartFile.useLDrawPart as unknown as ReturnType<typeof vi.fn>;
    mockUseLDrawPart.mockReturnValue({
      loading: false,
      visual: { clone: vi.fn().mockReturnValue({ traverse: vi.fn() }) },
      sites: [],
    });
  });

  it('renders successfully without undefined reference errors', async () => {
    const renderer = await ReactThreeTest.create(
      <InteractivePart partId="3673" colorCode={15} isStatic={false} />
    );

    // Ensures component does not throw errors on internal effects
    await ReactThreeTest.act(async () => {
      // Just let internal effects settle
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    
    expect(renderer.scene.children.length).toBeGreaterThan(0);
  });
});
