import type {
  Layer,
  PeerId,
  PeerTopology,
} from '../../../packages/protocol/control';

export const TOPOLOGY = {
  MIN_VIEWER_LAYER: 1,
  MAX_VIEWER_LAYER: 5,
  TARGET_PEERS_PER_LAYER: 3,
  MAX_PEERS_PER_LAYER: 5,
  MAX_PARENTS: 2,
} as const;

export interface TopologyMember {
  peerId: PeerId;
  layer: Layer;
}

type LayerGroups = [
  TopologyMember[],
  TopologyMember[],
  TopologyMember[],
  TopologyMember[],
  TopologyMember[],
  TopologyMember[],
];

export class TopologyCapacityError extends Error {
  constructor() {
    super('No viewer position is available');
    this.name = 'TopologyCapacityError';
  }
}

export function assignViewerLayer(
  members: Iterable<TopologyMember>,
): Layer {
  const grouped = groupAndValidateMembers(members);

  for (
    let layer = TOPOLOGY.MIN_VIEWER_LAYER;
    layer <= TOPOLOGY.MAX_VIEWER_LAYER;
    layer += 1
  ) {
    const currentLayer = layer as Layer;
    if (!hasAvailableParentLayer(grouped, currentLayer)) {
      break;
    }

    if (grouped[currentLayer].length < TOPOLOGY.TARGET_PEERS_PER_LAYER) {
      return currentLayer;
    }
  }

  for (
    let layer = TOPOLOGY.MIN_VIEWER_LAYER;
    layer <= TOPOLOGY.MAX_VIEWER_LAYER;
    layer += 1
  ) {
    const currentLayer = layer as Layer;
    if (!hasAvailableParentLayer(grouped, currentLayer)) {
      break;
    }

    if (grouped[currentLayer].length < TOPOLOGY.MAX_PEERS_PER_LAYER) {
      return currentLayer;
    }
  }

  throw new TopologyCapacityError();
}

export function buildPeerTopologies(
  members: Iterable<TopologyMember>,
): Map<PeerId, PeerTopology> {
  const grouped = groupAndValidateMembers(members);
  assertNoLayerGaps(grouped);

  const topologies = new Map<PeerId, PeerTopology>();
  for (const layerMembers of grouped) {
    for (const member of layerMembers) {
      topologies.set(member.peerId, {
        layer: member.layer,
        parents: [],
        children: [],
        siblings: [],
      });
    }
  }

  for (
    let layer = TOPOLOGY.MIN_VIEWER_LAYER;
    layer <= TOPOLOGY.MAX_VIEWER_LAYER;
    layer += 1
  ) {
    const currentLayer = layer as Layer;
    const layerMembers = grouped[currentLayer];

    for (const member of layerMembers) {
      const topology = getTopology(topologies, member.peerId);
      topology.siblings = layerMembers
        .filter((candidate) => candidate.peerId !== member.peerId)
        .map((candidate) => candidate.peerId);
    }

    const parentLayer = (currentLayer - 1) as Layer;
    const parentCandidates = grouped[parentLayer];
    const childCounts = new Map(
      parentCandidates.map((parent) => [parent.peerId, 0]),
    );

    for (const child of layerMembers) {
      const parentLimit = currentLayer === 1 ? 1 : TOPOLOGY.MAX_PARENTS;
      const selectedParents = [...parentCandidates]
        .sort((left, right) => {
          const loadDifference =
            getChildCount(childCounts, left.peerId) -
            getChildCount(childCounts, right.peerId);
          return loadDifference || left.peerId.localeCompare(right.peerId);
        })
        .slice(0, parentLimit);

      const childTopology = getTopology(topologies, child.peerId);
      for (const parent of selectedParents) {
        childTopology.parents.push(parent.peerId);
        getTopology(topologies, parent.peerId).children.push(child.peerId);
        childCounts.set(
          parent.peerId,
          getChildCount(childCounts, parent.peerId) + 1,
        );
      }
    }
  }

  for (const topology of topologies.values()) {
    topology.parents.sort();
    topology.children.sort();
    topology.siblings.sort();
  }

  return topologies;
}

export function compactViewerLayers(
  members: Iterable<TopologyMember>,
): Map<PeerId, Layer> {
  const grouped = groupAndValidateMembers(members);
  const layers = new Map<PeerId, Layer>();

  for (const host of grouped[0]) {
    layers.set(host.peerId, 0);
  }

  let nextLayer = TOPOLOGY.MIN_VIEWER_LAYER;
  for (
    let currentLayer = TOPOLOGY.MIN_VIEWER_LAYER;
    currentLayer <= TOPOLOGY.MAX_VIEWER_LAYER;
    currentLayer += 1
  ) {
    const sourceLayer = currentLayer as Layer;
    if (grouped[sourceLayer].length === 0) {
      continue;
    }

    for (const member of grouped[sourceLayer]) {
      layers.set(member.peerId, nextLayer as Layer);
    }
    nextLayer += 1;
  }

  return layers;
}

function groupAndValidateMembers(
  members: Iterable<TopologyMember>,
): LayerGroups {
  const grouped: LayerGroups = [[], [], [], [], [], []];
  const peerIds = new Set<PeerId>();

  for (const member of members) {
    if (!member.peerId || peerIds.has(member.peerId)) {
      throw new Error(`Invalid or duplicate peer ID: ${member.peerId}`);
    }
    if (!Number.isInteger(member.layer) || member.layer < 0 || member.layer > 5) {
      throw new Error(`Invalid layer for peer ${member.peerId}`);
    }

    peerIds.add(member.peerId);
    grouped[member.layer].push(member);
  }

  for (const layerMembers of grouped) {
    layerMembers.sort((left, right) => left.peerId.localeCompare(right.peerId));
  }

  if (grouped[0].length !== 1) {
    throw new Error('Topology must contain exactly one host in Layer 0');
  }

  for (
    let layer = TOPOLOGY.MIN_VIEWER_LAYER;
    layer <= TOPOLOGY.MAX_VIEWER_LAYER;
    layer += 1
  ) {
    const currentLayer = layer as Layer;
    if (grouped[currentLayer].length > TOPOLOGY.MAX_PEERS_PER_LAYER) {
      throw new Error(`Layer ${layer} exceeds its peer limit`);
    }
  }

  return grouped;
}

function hasAvailableParentLayer(
  grouped: LayerGroups,
  layer: Layer,
): boolean {
  const parentLayer = (layer - 1) as Layer;
  return grouped[parentLayer].length > 0;
}

function assertNoLayerGaps(grouped: LayerGroups): void {
  let foundEmptyLayer = false;

  for (
    let layer = TOPOLOGY.MIN_VIEWER_LAYER;
    layer <= TOPOLOGY.MAX_VIEWER_LAYER;
    layer += 1
  ) {
    const currentLayer = layer as Layer;
    if (grouped[currentLayer].length === 0) {
      foundEmptyLayer = true;
    } else if (foundEmptyLayer) {
      throw new Error(`Layer ${layer} cannot exist below an empty layer`);
    }
  }
}

function getTopology(
  topologies: Map<PeerId, PeerTopology>,
  peerId: PeerId,
): PeerTopology {
  const topology = topologies.get(peerId);
  if (!topology) {
    throw new Error(`Missing topology for peer ${peerId}`);
  }
  return topology;
}

function getChildCount(
  childCounts: Map<PeerId, number>,
  peerId: PeerId,
): number {
  return childCounts.get(peerId) ?? 0;
}
