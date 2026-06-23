import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Slipstream — the shared cache for AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#07080d",
          backgroundImage:
            "radial-gradient(900px 500px at 80% -10%, #1b2740 0%, rgba(7,8,13,0) 60%)",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ width: 132, height: 12, borderRadius: 8, background: "#5eead4" }} />
            <div style={{ width: 110, height: 12, borderRadius: 8, background: "#818cf8" }} />
            <div style={{ width: 150, height: 12, borderRadius: 8, background: "#c084fc" }} />
          </div>
        </div>
        <div
          style={{
            fontSize: 84,
            fontWeight: 800,
            color: "#f1f5f9",
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            marginTop: 18,
          }}
        >
          Slipstream
        </div>
        <div
          style={{
            fontSize: 40,
            color: "#aeb6c8",
            marginTop: 18,
            maxWidth: 940,
            lineHeight: 1.25,
          }}
        >
          Every agent makes the web cheaper for the next.
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 44 }}>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              color: "#5eead4",
              border: "1px solid #1c2030",
              borderRadius: 999,
              padding: "10px 22px",
              background: "#00000040",
            }}
          >
            ~73–89% fewer tokens
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              color: "#8a93a8",
              border: "1px solid #1c2030",
              borderRadius: 999,
              padding: "10px 22px",
              background: "#00000040",
            }}
          >
            Living web changelog
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
