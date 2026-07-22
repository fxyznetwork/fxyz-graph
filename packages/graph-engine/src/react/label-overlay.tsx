/**
 * Budgeted DOM label overlay v2.
 *
 * Labels are OURS by necessity — the renderer draws zero captions in any
 * mode (a known limitation of the underlying graph renderer). Per-frame
 * label count is bounded by the lens/tier budget via pickLabeledNodes,
 * independent of graph size. Positioning is CSS-transform only (no layout
 * thrash); the parent owns WHEN positions refresh (its view state).
 *
 * v2 (previously labels drifted visibly off their nodes): labels anchor to
 * the node's screen-space BOTTOM EDGE (center + radius, not center + 8px),
 * carry a rank hierarchy (the budget order is a salience order — top labels
 * render larger and brighter), collide greedily (a less salient label that
 * would overlap a kept one is culled, not stacked), and sit on a halo
 * shadow so they stay legible over edge crossings.
 */

import type { GraphNodeV1 } from "@fxyz/graph-contract";
import type { CSSProperties } from "react";
import { cssScale, type PaneView, worldToScreen } from "./view";

/** A budget-picked node plus its world-units anchor radius (node radius). */
export type LabelNode = GraphNodeV1 & { anchorRadius?: number };

const layerStyle: CSSProperties = {
	position: "absolute",
	inset: 0,
	overflow: "hidden",
	pointerEvents: "none",
};

const labelBaseStyle: CSSProperties = {
	position: "absolute",
	top: 0,
	left: 0,
	whiteSpace: "nowrap",
	maxWidth: 240,
	overflow: "hidden",
	textOverflow: "ellipsis",
	lineHeight: 1.2,
	letterSpacing: "0.02em",
	pointerEvents: "none",
	willChange: "transform",
	color: "var(--graphpane-label, rgba(233, 236, 241, 0.92))",
	textShadow: "0 1px 2px rgba(0, 0, 0, 0.85), 0 0 8px rgba(0, 0, 0, 0.55)",
};

/** Salience tiers by budget rank — the pick order IS the salience order. */
function tierFor(rank: number): { fontSize: number; opacity: number } {
	if (rank < 10) return { fontSize: 12, opacity: 0.95 };
	if (rank < 32) return { fontSize: 11, opacity: 0.78 };
	return { fontSize: 10, opacity: 0.6 };
}

/** Gap between the node's rendered edge and the label's top, css px. */
const ANCHOR_GAP = 5;

export interface PlacedLabel {
	node: LabelNode;
	x: number;
	y: number;
	fontSize: number;
	opacity: number;
}

/**
 * Breathing room around each label during collision culling. Tight glyph
 * boxes let 240px-wide lines stack ~16px apart without "intersecting" — which
 * on the public overview reads as an unreadable pile of text. The margin
 * makes near-touching labels collide, so density self-adapts to zoom: zoomed
 * out, more candidates collide and only the salient survive; zoomed in,
 * space opens and more labels return.
 */
const CULL_MARGIN_X = 12;
const CULL_MARGIN_Y = 8;

/**
 * Engine behavior mark, stamped on the overlay root as `data-engine`. Bump on
 * every behavior-visible engine change. Exists so that stale deployed
 * bundles serving pre-fix behavior can be told apart from fresh ones: with
 * this mark, `document.querySelector('[data-graphpane-labels]').dataset
 * .engine` answers "which engine is this surface actually running" in one
 * probe, no behavior forensics needed.
 */
export const ENGINE_BUILD_MARK = "e12-drag-pin";

/**
 * Pure viewport clamp for a label's center-x (exported for the test suite):
 * slide inward so the box stays whole — attached beats amputated. Panes
 * narrower than one label keep the anchor center (nothing sensible to clamp
 * to).
 */
export function clampLabelX(
	x: number,
	labelLength: number,
	fontSize: number,
	width: number,
): number {
	const halfWidth = Math.min(240, labelLength * fontSize * 0.62) / 2;
	const EDGE_PAD = 8;
	if (width <= (halfWidth + EDGE_PAD) * 2) return x;
	return Math.min(
		Math.max(x, EDGE_PAD + halfWidth),
		width - EDGE_PAD - halfWidth,
	);
}

/** Approximate label box for greedy collision culling (mono ≈ 0.62em/char),
 *  inflated by the cull margins. Exported for the declutter test suite. */
export function labelRect(p: PlacedLabel): {
	left: number;
	right: number;
	top: number;
	bottom: number;
} {
	const width = Math.min(240, p.node.label.length * p.fontSize * 0.62);
	const height = p.fontSize * 1.3;
	return {
		left: p.x - width / 2 - CULL_MARGIN_X,
		right: p.x + width / 2 + CULL_MARGIN_X,
		top: p.y - CULL_MARGIN_Y,
		bottom: p.y + height + CULL_MARGIN_Y,
	};
}

export function overlaps(
	a: ReturnType<typeof labelRect>,
	b: ReturnType<typeof labelRect>,
): boolean {
	return (
		a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
	);
}

export interface LabelOverlayProps {
	/** Already budget-picked (pickLabeledNodes) — this component never slices. */
	nodes: LabelNode[];
	view: PaneView;
	width: number;
	height: number;
	/**
	 * Chrome exclusion band, css px from the pane top (some surfaces' own
	 * tabs / lens switcher + hint sit INSIDE the pane, and labels rendered
	 * straight through them — text bleeding between the chrome buttons).
	 * Labels whose anchored top falls inside the band are culled; they
	 * re-enter as pan/zoom moves them out (the cull is per-view). 0 = no
	 * band.
	 */
	topInset?: number;
	className?: string;
}

export function LabelOverlay({
	nodes,
	view,
	width,
	height,
	topInset = 0,
	className,
}: LabelOverlayProps) {
	const scale = cssScale(view);
	const placed: PlacedLabel[] = [];
	for (const [rank, node] of nodes.entries()) {
		if (
			!Number.isFinite(node.x as number) ||
			!Number.isFinite(node.y as number)
		) {
			continue;
		}
		const p = worldToScreen(view, node.x as number, node.y as number);
		if (p.x < -80 || p.x > width + 80 || p.y < -40 || p.y > height + 40) {
			continue;
		}
		const radiusPx = (node.anchorRadius ?? 12.5) * scale;
		const tier = tierFor(rank);
		// Clamp into the viewport: the cull sees the CLAMPED rect, so slid
		// labels still claim honest space.
		const candidate: PlacedLabel = {
			node,
			x: clampLabelX(p.x, node.label.length, tier.fontSize, width),
			y: p.y + radiusPx + ANCHOR_GAP,
			...tier,
		};
		// Chrome exclusion: never render under the pane's own top chrome.
		if (candidate.y < topInset) continue;
		// Greedy cull: earlier (more salient) labels win the space.
		const rect = labelRect(candidate);
		let collided = false;
		for (const kept of placed) {
			if (overlaps(rect, labelRect(kept))) {
				collided = true;
				break;
			}
		}
		if (!collided) placed.push(candidate);
	}
	return (
		<div
			style={layerStyle}
			className={className}
			data-graphpane-labels
			data-engine={ENGINE_BUILD_MARK}
		>
			{placed.map(({ node, x, y, fontSize, opacity }) => (
				<span
					key={node.id}
					style={{
						...labelBaseStyle,
						fontSize,
						opacity,
						transform: `translate(-50%, 0) translate(${x}px, ${y}px)`,
					}}
				>
					{node.label}
				</span>
			))}
		</div>
	);
}
