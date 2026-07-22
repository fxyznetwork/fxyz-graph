/**
 * LensLegend — the color/size key every graph surface lacked (consumer-wiring
 * audit 2026-07-21, top gap #3: community palette and --fx-role-* accents
 * rendered with zero explanation).
 *
 * Presentational only: the CONTRACT declares what each encoding means
 * (LensSpec.legend); this component owns the swatch pixels. Role chips read
 * the locked --fx-role-* custom properties so the key can never drift from
 * the accents the style pipeline actually pushes. Consumers place it (it is
 * a block element, not fixed chrome) and give it their surface font.
 */

import { getLensSpec, type LegendEntry } from "@fxyz/graph-contract";
import type { CSSProperties } from "react";
import { COMMUNITY_PALETTE } from "../lens/apply";

const rowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 6,
};

const swatchBase: CSSProperties = {
	width: 8,
	height: 8,
	flex: "none",
};

function Swatch({ entry }: { entry: LegendEntry }) {
	switch (entry.encoding) {
		case "role":
			return (
				<span
					style={{ ...swatchBase, background: `var(--fx-role-${entry.role})` }}
				/>
			);
		case "community":
			return (
				<span style={{ display: "flex", gap: 1, flex: "none" }}>
					{COMMUNITY_PALETTE.slice(0, 5).map((c) => (
						<span key={c} style={{ width: 4, height: 8, background: c }} />
					))}
				</span>
			);
		case "size":
			return (
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 2,
						flex: "none",
					}}
				>
					<span
						style={{
							width: 4,
							height: 4,
							borderRadius: "50%",
							background: "currentColor",
							opacity: 0.7,
						}}
					/>
					<span
						style={{
							width: 8,
							height: 8,
							borderRadius: "50%",
							background: "currentColor",
							opacity: 0.7,
						}}
					/>
				</span>
			);
		case "brightness":
			return (
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 2,
						flex: "none",
					}}
				>
					{[1, 0.55, 0.25].map((o) => (
						<span
							key={o}
							style={{
								width: 6,
								height: 6,
								borderRadius: "50%",
								background: "currentColor",
								opacity: o,
							}}
						/>
					))}
				</span>
			);
	}
}

export interface LensLegendProps {
	/** Known lens id (contract registry) — no legend declared, no render. */
	lens: string;
	className?: string;
	style?: CSSProperties;
}

export function LensLegend({ lens, className, style }: LensLegendProps) {
	const entries = getLensSpec(lens)?.legend;
	if (!entries || entries.length === 0) return null;
	return (
		<div
			className={className}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 4,
				...style,
			}}
			data-graphpane-legend
		>
			{entries.map((entry) => (
				<div key={`${entry.encoding}:${entry.label}`} style={rowStyle}>
					<Swatch entry={entry} />
					<span>{entry.label}</span>
				</div>
			))}
		</div>
	);
}
