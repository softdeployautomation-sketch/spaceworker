// Static 3D-styled ambient scene drawn behind the desktop. Purely decorative:
// no keyframes, no JS/state — each translucent panel is a real CSS transform
// (rotateX / rotateY / rotateZ) under a fixed perspective, so it genuinely
// reads as depth without moving. Translated from Desktop.design.html.
export function DesktopBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{
        perspective: "1400px",
        background:
          "radial-gradient(60% 50% at 18% 8%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 45% at 85% 85%, rgba(99,102,241,0.12), transparent 60%), linear-gradient(160deg, #0d1220 0%, #080b12 75%)",
      }}
    >
      <Panel
        className="left-[10%] top-[14%] h-[100px] w-[150px] rounded-[12px]"
        gradient="linear-gradient(155deg, rgba(129,140,248,0.10), rgba(99,102,241,0.03))"
        border="rgba(129,140,248,0.16)"
        transform="rotateX(12deg) rotateY(-18deg) rotateZ(-3deg)"
        shadow="0 30px 50px -20px rgba(0,0,0,0.5)"
      />
      <Panel
        className="right-[14%] top-[10%] h-[82px] w-[120px] rounded-[11px]"
        gradient="linear-gradient(155deg, rgba(129,140,248,0.08), rgba(99,102,241,0.02))"
        border="rgba(129,140,248,0.13)"
        transform="rotateX(-8deg) rotateY(16deg) rotateZ(4deg)"
        shadow="0 26px 44px -18px rgba(0,0,0,0.45)"
      />
      <Panel
        className="bottom-[12%] left-[20%] h-[70px] w-[100px] rounded-[10px]"
        gradient="linear-gradient(155deg, rgba(129,140,248,0.07), rgba(99,102,241,0.02))"
        border="rgba(129,140,248,0.11)"
        transform="rotateX(6deg) rotateY(-10deg) rotateZ(2deg)"
        shadow="0 20px 36px -16px rgba(0,0,0,0.4)"
      />
      <Panel
        className="bottom-[18%] right-[22%] h-[112px] w-[170px] rounded-[13px]"
        gradient="linear-gradient(155deg, rgba(129,140,248,0.11), rgba(99,102,241,0.03))"
        border="rgba(129,140,248,0.17)"
        transform="rotateX(-10deg) rotateY(14deg) rotateZ(-2deg)"
        shadow="0 32px 54px -20px rgba(0,0,0,0.5)"
      />
    </div>
  );
}

function Panel({
  className,
  gradient,
  border,
  transform,
  shadow,
}: {
  className: string;
  gradient: string;
  border: string;
  transform: string;
  shadow: string;
}) {
  return (
    <div
      className={`absolute ${className}`}
      style={{
        background: gradient,
        border: `1px solid ${border}`,
        transform,
        boxShadow: shadow,
      }}
    />
  );
}