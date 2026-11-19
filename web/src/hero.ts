// Home page hero illustration: one 10-second loop of the main feature.
// Period 1 pays the merchant on time; an early pull bounces off the order ("refused by the network");
// period 2 pays on time; cancel sends the rest back to the subscriber. Pure SVG + CSS (style.css, .anim),
// no script. With prefers-reduced-motion the loop is replaced by one still frame and a one-line legend.
export const HERO_SVG = `
<svg viewBox="0 0 360 232" role="img" aria-labelledby="anim-t anim-d">
  <title id="anim-t">How a standing order behaves</title>
  <desc id="anim-d">Each period one payment moves from the order to the merchant. An early pull bounces off: refused by the network. On cancel, the coins still in the order go back to you.</desc>

  <g class="refused">
    <rect x="84" y="6" width="192" height="26" rx="13"/>
    <text x="180" y="24">✕ refused by the network</text>
  </g>

  <g class="node"><rect x="10" y="52" width="72" height="52" rx="12"/><text class="ico" x="46" y="86">👛</text></g>
  <text class="nl" x="46" y="124">You</text>

  <g class="vault"><rect x="138" y="44" width="84" height="68" rx="14"/></g>
  <text class="nl" x="180" y="130">The order</text>
  <text class="ns" x="180" y="145">coins carry the rules</text>

  <g class="node"><rect x="278" y="52" width="72" height="52" rx="12"/><text class="ico" x="314" y="86">🏪</text></g>
  <text class="nl" x="314" y="124">Merchant</text>

  <g class="coin c1"><circle cx="155" cy="78" r="8"/></g>
  <g class="coin c2"><circle cx="171" cy="78" r="8"/></g>
  <g class="coin c3"><circle cx="187" cy="78" r="8"/></g>
  <g class="coin c4"><circle cx="203" cy="78" r="8"/></g>

  <g class="early"><path d="M256 78 h22 M256 78 l9 -8 M256 78 l9 8"/></g>

  <line class="trk" x1="30" y1="176" x2="330" y2="176"/>
  <line class="trk-fill" x1="30" y1="176" x2="330" y2="176" pathLength="300"/>
  <g class="tick"><line x1="90" y1="168" x2="90" y2="184"/><text x="90" y="200">period 1</text></g>
  <g class="tick"><line x1="180" y1="168" x2="180" y2="184"/><text x="180" y="200">period 2</text></g>
  <g class="tick"><line x1="270" y1="168" x2="270" y2="184"/><text x="270" y="200">period 3</text></g>
  <g class="cancel"><rect x="204" y="148" width="52" height="20" rx="10"/><text x="230" y="162">cancel</text></g>
  <g class="cur"><circle cx="30" cy="176" r="6"/></g>

  <text class="cap k1" x="180" y="226">Period 1: paid on time</text>
  <text class="cap k2" x="180" y="226">Early pull: refused by the network</text>
  <text class="cap k3" x="180" y="226">Period 2: paid on time</text>
  <text class="cap k4" x="180" y="226">Cancel: the rest comes back to you</text>
  <text class="cap-still" x="180" y="226">On time: paid · Early: refused · Cancel: rest back</text>
</svg>`;
