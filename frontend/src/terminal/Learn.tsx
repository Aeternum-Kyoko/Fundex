import { TrustBadge } from "./primitives";
import "./design.css";

function Flow() {
  return (
    <svg className="ln-flow" viewBox="0 0 560 190" role="img" aria-label="Long on the exchange that pays you, short on the exchange where you get paid">
      <rect x="10" y="40" width="190" height="110" rx="18" fill="var(--t-surface)" stroke="var(--t-line-strong)" />
      <rect x="360" y="40" width="190" height="110" rx="18" fill="var(--t-surface)" stroke="var(--t-line-strong)" />
      <text x="105" y="72" textAnchor="middle" fill="var(--t-text-3)" fontSize="13">Exchange A</text>
      <text x="455" y="72" textAnchor="middle" fill="var(--t-text-3)" fontSize="13">Exchange B</text>
      <text x="105" y="102" textAnchor="middle" fill="var(--t-pay)" fontSize="20" fontWeight="600">Buy $1,000</text>
      <text x="455" y="102" textAnchor="middle" fill="var(--t-receive)" fontSize="20" fontWeight="600">Sell $1,000</text>
      <text x="105" y="128" textAnchor="middle" fill="var(--t-text-2)" fontSize="13">pays 0.01% every 8h</text>
      <text x="455" y="128" textAnchor="middle" fill="var(--t-text-2)" fontSize="13">earns 0.05% every 8h</text>
      <line x1="215" y1="95" x2="345" y2="95" stroke="var(--t-receive)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 8" />
      <text x="280" y="82" textAnchor="middle" fill="var(--t-receive)" fontSize="13" fontWeight="600">keep 0.04%</text>
      <text x="280" y="175" textAnchor="middle" fill="var(--t-text-3)" fontSize="12.5">Price moves cancel out. The funding gap is what's left.</text>
    </svg>
  );
}

export function Learn() {
  return (
    <main className="t-main td-page ln-page">
      <header className="td-head">
        <div>
          <a className="td-back" href="/">Dashboard</a>
          <h1 className="td-title">How Fundex works</h1>
          <p className="t-soft td-sub">Funding arbitrage in plain language, and how to read every number on the screen.</p>
        </div>
      </header>

      <section className="t-panel td-section ln-section">
        <h2>The idea</h2>
        <p>
          Perpetual futures have no expiry, so exchanges keep their price close to the real one with a <strong>funding payment</strong>, exchanged between longs and shorts every few hours.
          The rate is different on every exchange.
        </p>
        <p>
          When one exchange pays shorts more than another charges longs, you can <strong>buy on one and sell the same size on the other</strong>. Your price risk cancels out, and you keep the
          difference in funding.
        </p>
        <Flow />
      </section>

      <section className="t-panel td-section ln-section">
        <h2>Two ways to trade it</h2>
        <dl className="ln-defs">
          <div>
            <dt>Next funding</dt>
            <dd>Open just before a settlement, collect that one payment, and close right after. Short exposure, so the main risk is the cost of getting in and out.</dd>
          </div>
          <div>
            <dt>Hold</dt>
            <dd>Keep the hedge on and collect every settlement for a set period. You earn more if the spread lasts, but rates can change while you wait.</dd>
          </div>
        </dl>
      </section>

      <section className="t-panel td-section ln-section">
        <h2>Reading the numbers</h2>
        <dl className="ln-defs">
          <div>
            <dt>Spread /8h</dt>
            <dd>The gap between the two rates, with each leg converted to the same 8-hour basis so a 1-hour and an 8-hour exchange compare fairly.</dd>
          </div>
          <div>
            <dt>Net over the hold</dt>
            <dd>Funding you'd collect over the holding period, minus fees and slippage, paid once for getting in and out. This is the number that decides if it's worth it.</dd>
          </div>
          <div>
            <dt>Break-even</dt>
            <dd>How long the spread has to last just to pay back the costs. Anything longer than the time you plan to hold is a loss.</dd>
          </div>
          <div>
            <dt>APR</dt>
            <dd>Net return stretched to a year. A way to compare setups, not a promise: spreads rarely stay put that long.</dd>
          </div>
        </dl>
      </section>

      <section className="t-panel td-section ln-section">
        <h2>What it costs</h2>
        <p>
          Every trade pays the <strong>taker fee</strong> on both exchanges, when opening and when closing, plus <strong>slippage</strong>: the price you actually get compared with the middle
          price. Fundex measures slippage from each exchange's live order book for the reference size, and says when it could only estimate. The Depth section in a pair's details shows how
          much you can trade before slippage passes 0.1%.
        </p>
      </section>

      <section className="t-panel td-section ln-section">
        <h2>Trust levels</h2>
        <p>Every pair runs a set of checks. The level tells you how much to believe the number.</p>
        <ul className="ln-trust">
          <li>
            <TrustBadge level="high" /> Every check passed and the edge has lasted. Safest to act on.
          </li>
          <li>
            <TrustBadge level="medium" /> A couple of warnings, or a spread that is too new to know whether it's a spike.
          </li>
          <li>
            <TrustBadge level="low" /> At least one check failed, like stale data, an order book too thin for the size, or costs that beat the funding.
          </li>
        </ul>
        <p className="t-soft">
          Checks cover feed freshness, order-book depth, price match between exchanges, rate refresh cadence, funding intervals, profit after costs, and persistence. The small chips beside
          a pair, like "Thin liquidity" or "Stale feed", name the ones to look at first.
        </p>
      </section>

      <section className="t-panel td-section ln-section">
        <h2>What can still go wrong</h2>
        <ul className="ln-list">
          <li>Rates are predicted until the settlement happens, and can change before you're paid.</li>
          <li>Prices on the two exchanges can drift apart and move your profit and loss, even though the position is hedged.</li>
          <li>A leg can fail to fill, or one exchange can go down, leaving you exposed on the other.</li>
          <li>Leverage magnifies margin needs on both sides. Keep spare margin on each exchange.</li>
        </ul>
        <p className="t-soft">Paper trading uses live books and real funding rates, so you can test a setup end to end first. Past results from the backtest don't guarantee the next payment.</p>
      </section>

      <section className="t-panel td-section ln-section">
        <h2>Where to start</h2>
        <div className="td-switches">
          <a className="t-btn" data-primary="true" href="/">See the best pairs</a>
          <a className="t-btn" href="/?tab=heatmap">Open the heatmap</a>
          <a className="t-btn" href="/backtest">Run a backtest</a>
          <a className="t-btn" href="/trade">Paper trade</a>
        </div>
      </section>
    </main>
  );
}
