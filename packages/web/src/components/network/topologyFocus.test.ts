import { describe, expect, it } from 'vitest';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useTopologyFocus } from './topologyFocus.js';

describe('the Topology box and the selected destination', () => {
  it('a destination chosen anywhere clears the box, with the diagram not drawn', () => {
    useSessionStore.getState().setNetDest(null);
    useTopologyFocus.getState().setBox('s-1', 'svc:proxy');
    // As the Network tab or the Map would: nothing of Topology is mounted.
    useSessionStore.getState().setNetDest('arxiv.org');
    expect(useTopologyFocus.getState().box).toBeNull();
  });

  it('clearing the destination leaves a box chosen since alone', () => {
    useTopologyFocus.getState().setBox('s-1', 'route:tunnel');
    useSessionStore.getState().setNetDest(null);
    expect(useTopologyFocus.getState().box).toBe('route:tunnel');
  });
});
