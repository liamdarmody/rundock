// Investment Partner for Rundock: the extension's view, built on Rundock UI.
//
// Rundock mounts this file in a sandboxed frame on a note whose frontmatter
// carries `investment-partner:`, and posts it an `init` with that note's
// path and text. Before this file runs, Rundock has put its design tokens
// and Rundock UI (window.Rundock.ui) into the frame, so every control here
// is Rundock's own and follows the app's theme. The marker picks the screen:
//
//   investment-partner: dashboard         the dashboard, drawn from the notes
//                                         it lists under `sources:`
//   investment-partner: portfolio         allocation and editable positions
//   investment-partner: risk-profile      the risk control panel
//   investment-partner: decision-journal  the decision board
//
// A dashboard note holds no data of its own. It names the three notes it
// draws, as exact paths under `sources:`, and Rundock (0.15 and later)
// hands the view exactly those, in `init.sources` and again in a `sources`
// message whenever one changes. The view writes a source back with
// `changeSource`, and never writes the dashboard note, so it can never
// change which files it is given. Each data note opened on its own draws
// its own part of the dashboard and writes back with `change`, which is how
// the notes work on a Rundock without named sources.
//
// A note's data is its first ```json block. Everything else in the note is
// the person's own prose and is written back untouched. Every edit is
// written as it is made; Rundock writes once the edits pause, through the
// guarded save its editors use, so a note changed elsewhere since it was
// opened is not silently overwritten. There are no Save buttons.
//
// UMD-shaped, like Rundock's own examples: under Node the note format, the
// math, the risk check and the message adapter load for the tests; in the
// frame the view boots.

(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else {
    root.RundockInvestmentPartner = lib;
    lib.boot(root);
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARKER = 'investment-partner';
  // The data notes. A dashboard note is a fifth marker value with no data of
  // its own, read by the view rather than by readNote.
  var KINDS = ['portfolio', 'risk-profile', 'decision-journal'];
  var DASHBOARD = 'dashboard';
  var STALE_MS = 24 * 60 * 60 * 1000;
  var STATUSES = ['proposed', 'approved', 'executed', 'rejected', 'archived'];
  var REGIMES = [
    { value: 'aggressive-growth', label: 'Aggressive growth' },
    { value: 'growth-and-income', label: 'Growth & income' },
    { value: 'capital-preservation', label: 'Capital preservation' },
    { value: 'value-opportunities', label: 'Value opportunities' },
  ];

  // ---------------------------------------------------------------------
  // The note: marker, data block, and writing the block back.
  // ---------------------------------------------------------------------

  function unquote(value) {
    var v = String(value).trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
      return v.slice(1, -1);
    }
    return v;
  }

  // The frontmatter block's text, read the way Rundock's registry decides a
  // marker claim: the note opens with "---" and the block closes on a line
  // of its own. Null when there is none.
  // `end` indexes the note's own text, whatever its line endings, because
  // the data block is found and replaced in that text.
  function frontmatterOf(content) {
    var src = String(content);
    if (src.slice(0, 3) !== '---') return null;
    var closing = src.slice(3).match(/\r?\n---/);
    if (!closing) return null;
    return { text: src.slice(3, 3 + closing.index).replace(/\r\n/g, '\n'), end: 3 + closing.index + closing[0].length };
  }

  function kindOf(content) {
    var fm = frontmatterOf(content);
    if (!fm) return null;
    var lines = fm.text.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var m = lines[i].match(/^investment-partner:(.*)$/);
      if (m) return unquote(m[1]);
    }
    return null;
  }

  // The first fenced json block after the frontmatter: where its body
  // starts and ends in the note's text, so a write replaces exactly that.
  var FENCE = /(^|\n)```json[ \t]*\r?\n([\s\S]*?)\r?\n```/;
  function dataBlock(content) {
    var src = String(content);
    var fm = frontmatterOf(src);
    var offset = fm ? fm.end : 0;
    var m = FENCE.exec(src.slice(offset));
    if (!m) return null;
    var start = offset + m.index + m[1].length + m[0].slice(m[1].length).indexOf('\n') + 1;
    return { start: start, end: start + m[2].length, text: m[2] };
  }

  function isFraction(n) {
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 1;
  }

  // Each kind's minimum shape, checked before anything is drawn, so a note
  // an agent or a person broke is named as broken rather than drawn wrong.
  function shapeProblem(kind, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'the data block is not a JSON object';
    if (kind === 'portfolio') {
      if (!Array.isArray(data.accounts)) return 'a portfolio needs an "accounts" list';
      for (var i = 0; i < data.accounts.length; i += 1) {
        var a = data.accounts[i];
        if (!a || typeof a.name !== 'string') return 'every account needs a "name"';
        if (a.positions !== undefined && !Array.isArray(a.positions)) return 'account "' + a.name + '" has "positions" that is not a list';
      }
      if (data.baseCurrency !== undefined && !/^[A-Z]{3}$/.test(String(data.baseCurrency))) return '"baseCurrency" must be a three-letter currency code, such as GBP';
      if (data.sample !== undefined && typeof data.sample !== 'boolean') return '"sample" must be true or false';
      return null;
    }
    if (kind === 'risk-profile') {
      var c = data.constraints;
      if (!c || typeof c !== 'object') return 'a risk profile needs a "constraints" object';
      var keys = ['maximumSinglePositionFraction', 'maximumSectorFraction', 'minimumCashReserveFraction'];
      for (var k = 0; k < keys.length; k += 1) {
        if (!isFraction(c[keys[k]])) return '"' + keys[k] + '" must be a number from 0 to 1';
      }
      // Added in schema 2, so optional: a schema 1 note still reads, and a
      // limit it never set is not checked rather than invented.
      var optional = ['maximumAccountFraction', 'maximumIlliquidFraction'];
      for (var o = 0; o < optional.length; o += 1) {
        if (c[optional[o]] !== undefined && !isFraction(c[optional[o]])) return '"' + optional[o] + '" must be a number from 0 to 1';
      }
      if (data.strategyRegime !== undefined && !REGIMES.some(function (r) { return r.value === data.strategyRegime; })) {
        return '"strategyRegime" must be one of ' + REGIMES.map(function (r) { return r.value; }).join(', ');
      }
      return null;
    }
    if (kind === 'decision-journal') {
      if (!Array.isArray(data.entries)) return 'a decision journal needs an "entries" list';
      return null;
    }
    return null;
  }

  // The note as this view reads it, or a named reason it cannot be.
  function readNote(content) {
    if (typeof content !== 'string') return { error: 'Rundock sent no note text to draw' };
    var kind = kindOf(content);
    if (kind === null) return { error: 'the note carries no ' + MARKER + ' marker in its frontmatter' };
    if (KINDS.indexOf(kind) === -1) {
      return { error: 'the marker says "' + kind + '", and this view draws ' + KINDS.join(', ') };
    }
    var block = dataBlock(content);
    if (!block) return { error: 'the note has no ```json block holding its data' };
    var data;
    try {
      data = JSON.parse(block.text);
    } catch (e) {
      return { error: 'the ```json block is not valid JSON (' + e.message + ')' };
    }
    var problem = shapeProblem(kind, data);
    if (problem) return { error: problem };
    return { kind: kind, data: data };
  }

  // The note with its data block replaced and nothing else touched. The
  // note's own line endings are kept, so a save changes only the data.
  function writeNote(content, data) {
    var block = dataBlock(content);
    if (!block) throw new Error('the note has no ```json block to write into');
    var body = JSON.stringify(data, null, 2);
    if (String(content).indexOf('\r\n') !== -1) body = body.replace(/\n/g, '\r\n');
    return content.slice(0, block.start) + body + content.slice(block.end);
  }

  // ---------------------------------------------------------------------
  // Portfolio math, unchanged from the original: every number the
  // allocation charts and concentration figures need.
  // ---------------------------------------------------------------------

  function marketValue(position) {
    if (!position.currentPrice) return 0;
    return position.quantity * position.currentPrice.amount;
  }

  function isStale(position, now) {
    if (!position.currentPrice || !position.currentPrice.asOf) return false;
    var age = (now === undefined ? Date.now() : now) - new Date(position.currentPrice.asOf).getTime();
    return age > STALE_MS;
  }

  function allPositions(portfolio) {
    var out = [];
    (portfolio.accounts || []).forEach(function (account) {
      (account.positions || []).forEach(function (position) {
        out.push({ account: account, position: position });
      });
    });
    return out;
  }

  function totalCash(portfolio) {
    return (portfolio.accounts || []).reduce(function (sum, a) { return sum + (a.cashBalance || 0); }, 0);
  }

  function totalMarketValue(portfolio) {
    return allPositions(portfolio).reduce(function (sum, p) { return sum + marketValue(p.position); }, 0) + totalCash(portfolio);
  }

  function groupSum(portfolio, keyFn) {
    var totals = {};
    allPositions(portfolio).forEach(function (p) {
      var key = keyFn(p);
      totals[key] = (totals[key] || 0) + marketValue(p.position);
    });
    return totals;
  }

  function largestSinglePositionFraction(portfolio, total) {
    if (total <= 0) return 0;
    var max = 0;
    allPositions(portfolio).forEach(function (p) {
      var f = marketValue(p.position) / total;
      if (f > max) max = f;
    });
    return max;
  }

  function largestSectorFraction(portfolio, total) {
    if (total <= 0) return 0;
    var sectors = groupSum(portfolio, function (p) { return p.position.sector; });
    var max = 0;
    Object.keys(sectors).forEach(function (s) { if (sectors[s] / total > max) max = sectors[s] / total; });
    return max;
  }

  function cashReserveFraction(portfolio, total) {
    if (total <= 0) return 0;
    return totalCash(portfolio) / total;
  }

  // ---------------------------------------------------------------------
  // Schema 2: allocation by any dimension, and the five limits checked.
  // Pure, so every number the dashboard shows is pinned by a test.
  // ---------------------------------------------------------------------

  var DIMENSIONS = [
    { value: 'assetClass', label: 'Asset class' },
    { value: 'sector', label: 'Sector' },
    { value: 'geography', label: 'Geography' },
    { value: 'accountType', label: 'Account type' },
  ];
  var CASH = 'Cash';
  var UNCLASSIFIED = 'Unclassified';

  function accountValue(account) {
    return (account.positions || []).reduce(function (s, p) { return s + marketValue(p); }, 0) + (account.cashBalance || 0);
  }

  // Every account with its value and its share of the whole, in the
  // note's own order, which is the order the person chose.
  function accountBreakdown(portfolio) {
    var total = totalMarketValue(portfolio);
    return (portfolio.accounts || []).map(function (a) {
      var value = accountValue(a);
      return { name: a.name, type: a.type || null, value: value, fraction: total > 0 ? value / total : 0 };
    });
  }

  // The portfolio split by one dimension, largest first. Cash is its own
  // row, so the rows always add up to the whole. Account type groups whole
  // accounts, cash included, because cash sits in an account.
  function allocation(portfolio, dimension) {
    var total = totalMarketValue(portfolio);
    var totals = {};
    var add = function (key, value) { totals[key] = (totals[key] || 0) + value; };
    if (dimension === 'accountType') {
      accountBreakdown(portfolio).forEach(function (a) { add(a.type || UNCLASSIFIED, a.value); });
    } else {
      allPositions(portfolio).forEach(function (p) { add(p.position[dimension] || UNCLASSIFIED, marketValue(p.position)); });
      var cash = totalCash(portfolio);
      if (cash > 0) add(CASH, cash);
    }
    return Object.keys(totals)
      .filter(function (k) { return totals[k] > 0; })
      .sort(function (a, b) { return totals[b] - totals[a]; })
      .map(function (k) { return { label: k, value: totals[k], fraction: total > 0 ? totals[k] / total : 0 }; });
  }

  // One ticker held in two accounts is one exposure.
  function holdings(portfolio) {
    var byTicker = {};
    var order = [];
    allPositions(portfolio).forEach(function (p) {
      var t = p.position.ticker;
      if (!byTicker[t]) { byTicker[t] = { ticker: t, value: 0, fund: false, illiquid: false, sector: p.position.sector || UNCLASSIFIED }; order.push(t); }
      byTicker[t].value += marketValue(p.position);
      byTicker[t].fund = byTicker[t].fund || p.position.fund === true;
      byTicker[t].illiquid = byTicker[t].illiquid || p.position.illiquid === true;
    });
    return order.map(function (t) { return byTicker[t]; });
  }

  // The limits in force. A schema 1 profile has no account or illiquid
  // limit, and those two checks are then reported as not set, never
  // compared against a number the person did not choose.
  function limitsOf(risk) {
    var c = (risk && risk.constraints) || {};
    var opt = function (v) { return isFraction(v) ? v : null; };
    return {
      position: c.maximumSinglePositionFraction,
      sector: c.maximumSectorFraction,
      account: opt(c.maximumAccountFraction),
      cash: c.minimumCashReserveFraction,
      illiquid: opt(c.maximumIlliquidFraction),
    };
  }

  // The five checks, each with what it measured and everything over it.
  // A fund (fund: true, an index or bond fund) is many positions across
  // many sectors, so it counts toward neither the single-position nor the
  // sector limit; everything else counts toward all five.
  function riskChecks(portfolio, risk) {
    var total = totalMarketValue(portfolio);
    var f = function (v) { return total > 0 ? v / total : 0; };
    var limits = limitsOf(risk);
    // An empty portfolio holds nothing to be over or under a limit, so every
    // check reports nothing rather than an empty cash reserve.
    if (total <= 0) {
      return LIMIT_CHECKS.map(function (c) { return { id: c.id, label: c.label, limit: limits[c.id], isMinimum: c.id === 'cash', actual: 0, over: [] }; });
    }
    var single = holdings(portfolio).filter(function (h) { return !h.fund; });
    var sectors = {};
    single.forEach(function (h) { sectors[h.sector] = (sectors[h.sector] || 0) + h.value; });
    var sectorRows = Object.keys(sectors).map(function (s) { return { name: s, fraction: f(sectors[s]) }; });
    var accountRows = accountBreakdown(portfolio).map(function (a) { return { name: a.name, fraction: a.fraction }; });
    var illiquid = f(holdings(portfolio).filter(function (h) { return h.illiquid; }).reduce(function (s, h) { return s + h.value; }, 0));
    var cash = f(totalCash(portfolio));
    var maxOf = function (rows) { return rows.reduce(function (m, r) { return Math.max(m, r.fraction); }, 0); };
    var over = function (rows, limit) {
      return limit === null ? [] : rows.filter(function (r) { return r.fraction > limit; }).sort(function (a, b) { return b.fraction - a.fraction; });
    };
    var positionRows = single.map(function (h) { return { name: h.ticker, fraction: f(h.value) }; });
    return [
      { id: 'position', label: 'Max single position', limit: limits.position, isMinimum: false, actual: maxOf(positionRows), over: over(positionRows, limits.position) },
      { id: 'sector', label: 'Max sector concentration', limit: limits.sector, isMinimum: false, actual: maxOf(sectorRows), over: over(sectorRows, limits.sector) },
      { id: 'account', label: 'Max single account exposure', limit: limits.account, isMinimum: false, actual: maxOf(accountRows), over: over(accountRows, limits.account) },
      { id: 'cash', label: 'Min cash reserve', limit: limits.cash, isMinimum: true, actual: cash, over: cash < limits.cash ? [{ name: CASH, fraction: cash }] : [] },
      { id: 'illiquid', label: 'Max illiquid assets', limit: limits.illiquid, isMinimum: false, actual: illiquid, over: limits.illiquid !== null && illiquid > limits.illiquid ? [{ name: 'Illiquid assets', fraction: illiquid }] : [] },
    ];
  }

  var LIMIT_CHECKS = [
    { id: 'position', label: 'Max single position' }, { id: 'sector', label: 'Max sector concentration' },
    { id: 'account', label: 'Max single account exposure' }, { id: 'cash', label: 'Min cash reserve' },
    { id: 'illiquid', label: 'Max illiquid assets' },
  ];

  // Every allocation outside a limit, one per line, in the checks' order.
  function breaches(checks) {
    var out = [];
    checks.forEach(function (c) { c.over.forEach(function (o) { out.push({ check: c.id, name: o.name, fraction: o.fraction, limit: c.limit }); }); });
    return out;
  }

  // The one way a fraction is written anywhere in this view, and in every
  // message it drafts: a percentage to one decimal ("11.0%", "8.0%").
  function pct1(fraction) { return ((fraction || 0) * 100).toFixed(1) + '%'; }

  // One plain sentence per breach, which is what the alert says and what
  // an ask carries to Lead Partner.
  function breachSentence(b) {
    var at = pct1(b.fraction);
    var lim = pct1(b.limit);
    if (b.check === 'position') return b.name + ' is ' + at + ' of the portfolio, above the ' + lim + ' single-position maximum.';
    if (b.check === 'sector') return b.name + ' is ' + at + ' of the portfolio, above the ' + lim + ' sector maximum.';
    if (b.check === 'account') return b.name + ' holds ' + at + ' of the portfolio, above the ' + lim + ' single-account maximum.';
    if (b.check === 'cash') return 'Cash is ' + at + ' of the portfolio, below the ' + lim + ' minimum reserve.';
    return 'Illiquid assets are ' + at + ' of the portfolio, above the ' + lim + ' maximum.';
  }

  function regimeLabel(value) {
    var found = REGIMES.filter(function (r) { return r.value === value; })[0];
    return found ? found.label : null;
  }

  // ---------------------------------------------------------------------
  // What an ask puts in the message box. Plain text the person reads,
  // changes or discards before anything is sent; nothing here is sent.
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Currency. One per portfolio (baseCurrency), never converted: changing it
  // relabels every amount. Written with Intl.NumberFormat in the person's
  // locale, so GBP reads £399,920 and EUR in German 399.920 €.
  // ---------------------------------------------------------------------

  var COMMON_CURRENCIES = ['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'INR', 'ZAR'];
  var REGION_CURRENCY = {
    GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', LI: 'CHF', JP: 'JPY', SG: 'SGD', HK: 'HKD',
    SE: 'SEK', NO: 'NOK', DK: 'DKK', IN: 'INR', ZA: 'ZAR',
    IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR',
    LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
  };

  function regionOf(locale) {
    try {
      var l = new Intl.Locale(locale || 'en-US');
      return (l.maximize ? l.maximize() : l).region || null;
    } catch (e) { return null; }
  }

  // A new or empty portfolio's currency, from the locale's region.
  function defaultCurrency(locale) { return REGION_CURRENCY[regionOf(locale)] || 'USD'; }

  // A three-letter code this runtime knows as a currency.
  function isCurrencyCode(code) {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
    if (typeof Intl.supportedValuesOf === 'function') {
      try { return Intl.supportedValuesOf('currency').indexOf(code) !== -1; } catch (e) { /* fall through */ }
    }
    return true;
  }

  function currencyOf(portfolio, locale) {
    var c = portfolio && portfolio.baseCurrency;
    return isCurrencyCode(c) ? c : defaultCurrency(locale);
  }

  // An amount in a currency, whole units unless `exact` and it has a
  // fraction (then the currency's own minor units).
  function money(n, currency, locale, exact) {
    var value = typeof n === 'number' && isFinite(n) ? n : 0;
    var c = isCurrencyCode(currency) ? currency : 'USD';
    var opts = { style: 'currency', currency: c };
    if (!(exact && value % 1)) { opts.minimumFractionDigits = 0; opts.maximumFractionDigits = 0; }
    try {
      return new Intl.NumberFormat(locale || 'en-US', opts).format(value);
    } catch (e) {
      return c + ' ' + Math.round(value).toLocaleString('en-US');
    }
  }

  // Whether an amount needs its code beside it to be read unambiguously. A
  // symbol that already names its country (US$, CA$, JP¥, CHF) does not; a
  // bare one ($, £, €, kr, R) might be several currencies, so the code goes
  // beside it. Never "US$399,920 · USD".
  function currencyNeedsCode(currency, locale) {
    var symbol = '';
    try {
      symbol = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: currency }).formatToParts(0)
        .filter(function (p) { return p.type === 'currency'; }).map(function (p) { return p.value; })[0] || '';
    } catch (e) { return true; }
    if (symbol === currency) return false;
    return !/[A-Z]{2,}/.test(symbol);
  }

  // A plain number typed into an amount field: digits, one decimal point and
  // thousands separators, with the currency's own symbol allowed in front.
  function parseAmount(text, currency, locale) {
    var t = String(text == null ? '' : text).trim();
    var symbol = '';
    try {
      symbol = new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency: currency || 'USD' }).formatToParts(0)
        .filter(function (p) { return p.type === 'currency'; }).map(function (p) { return p.value; })[0] || '';
    } catch (e) { /* no symbol */ }
    if (symbol && t.indexOf(symbol) === 0) t = t.slice(symbol.length).trim();
    t = t.replace(/^[$£€¥]/, '').replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
    return Number(t);
  }

  // ---------------------------------------------------------------------
  // Sample data, and the empty notes a person can start from instead.
  // ---------------------------------------------------------------------

  // The starter portfolio carries "sample": true until it is edited: any
  // write this view makes clears it, and so does Lead Partner's.
  function isSample(portfolio) { return !!(portfolio && portfolio.sample === true); }
  function emptyPortfolio(currency) { return { schemaVersion: 2, baseCurrency: currency, accounts: [] }; }
  function emptyJournal() { return { schemaVersion: 2, entries: [] }; }

  // ---------------------------------------------------------------------
  // Accounts and positions, edited in place.
  // ---------------------------------------------------------------------

  var ACCOUNT_TYPES = {
    GBP: ['Stocks & Shares ISA', 'Lifetime ISA', 'Cash ISA', 'SIPP', 'Workplace pension', 'General Investment Account'],
    USD: ['Taxable', 'Roth IRA', 'Traditional IRA', '401(k)', 'HSA'],
  };
  function accountTypeSuggestions(currency) { return (ACCOUNT_TYPES[currency] || []).concat(['Cash', 'Crypto']); }

  function newAccountName(portfolio) {
    var names = (portfolio.accounts || []).map(function (a) { return String(a.name).toLowerCase(); });
    if (names.indexOf('new account') === -1) return 'New account';
    for (var i = 2; ; i += 1) if (names.indexOf('new account ' + i) === -1) return 'New account ' + i;
  }

  // An account as the edit row holds it: a name nobody else has, a free-text
  // type, and a cash balance that is a number of zero or more.
  function checkAccount(portfolio, index, form, currency, locale) {
    var errors = {};
    var name = String(form.name == null ? '' : form.name).trim();
    if (!name) errors.name = 'Give the account a name.';
    else if ((portfolio.accounts || []).some(function (a, i) { return i !== index && String(a.name).trim().toLowerCase() === name.toLowerCase(); })) {
      errors.name = 'Another account is already called ' + name + '.';
    }
    var cashText = String(form.cash == null ? '' : form.cash).trim();
    var cash = cashText === '' ? 0 : parseAmount(cashText, currency, locale);
    if (!(cash >= 0)) errors.cash = 'Enter the cash held, as a number of ' + currency + ', or leave it empty for none.';
    if (Object.keys(errors).length) return { errors: errors };
    return { account: { name: name, type: String(form.type == null ? '' : form.type).trim(), cash: cash } };
  }

  // Why an account cannot be removed yet, or null when it can.
  function accountRemoveBlock(account) {
    var n = (account.positions || []).length;
    return n ? 'Move or remove its ' + (n === 1 ? 'position' : n + ' positions') + ' first; an account is removed only when it holds none.' : null;
  }

  function checkTicker(text) {
    var ticker = String(text == null ? '' : text).trim().toUpperCase();
    if (!ticker) return { error: 'Enter a ticker, such as MSFT.' };
    if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)) return { error: 'A ticker is letters and digits, such as MSFT or BRK.B.' };
    return { ticker: ticker };
  }

  function regionName(locale) {
    var region = regionOf(locale);
    try { return region ? new Intl.DisplayNames(['en'], { type: 'region' }).of(region) : null; } catch (e) { return null; }
  }

  // The category fields a new position starts with; each is editable.
  function defaultCategories(locale) {
    return { assetClass: 'Equity', sector: 'Unclassified', geography: regionName(locale) || 'Unclassified' };
  }

  // A position as the add row holds it.
  function checkPosition(portfolio, form, currency, locale) {
    var errors = {};
    var t = checkTicker(form.ticker);
    if (t.error) errors.ticker = t.error;
    var index = Number(form.account);
    if (!(portfolio.accounts || [])[index]) errors.account = 'Choose the account that holds it.';
    var quantity = parseAmount(form.quantity, currency, locale);
    if (!(quantity > 0)) errors.quantity = 'Enter how many you hold, above zero.';
    var price = parseAmount(form.price, currency, locale);
    if (!(price > 0)) errors.price = 'Enter the price of one, in ' + currency + ', above zero.';
    var cats = {};
    ['assetClass', 'sector', 'geography'].forEach(function (k) {
      var v = String(form[k] == null ? '' : form[k]).trim();
      cats[k] = v || 'Unclassified';
    });
    if (Object.keys(errors).length) return { errors: errors };
    var position = {
      ticker: t.ticker, quantity: quantity, assetClass: cats.assetClass, sector: cats.sector, geography: cats.geography,
      currentPrice: { amount: price, currency: currency, asOf: new Date().toISOString() },
    };
    // Only ever written when true, as in the starter notes.
    if (form.fund === true) position.fund = true;
    if (form.illiquid === true) position.illiquid = true;
    return { account: index, position: position };
  }

  // Changing the currency relabels: every price is marked with the new
  // code and no amount changes.
  function relabelCurrency(portfolio, currency) {
    var next = JSON.parse(JSON.stringify(portfolio));
    next.baseCurrency = currency;
    allPositions(next).forEach(function (p) { if (p.position.currentPrice) p.position.currentPrice.currency = currency; });
    return next;
  }

  function notesLine(paths) {
    return paths.length ? 'My notes: ' + paths.join(', ') + '.' : '';
  }

  // A proposed trade, as the form holds it, checked before anything is
  // drafted: a ticker, buy or sell, and a positive amount in the portfolio's
  // currency. Answers the cleaned trade, or an error per field in words.
  var SIDES = [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }];
  function checkTrade(form, currency, locale) {
    var f = form || {};
    var cur = currency || 'USD';
    var errors = {};
    var ticker = String(f.ticker == null ? '' : f.ticker).trim().toUpperCase();
    if (!ticker) errors.ticker = 'Enter a ticker, such as MSFT.';
    else if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(ticker)) errors.ticker = 'A ticker is letters and digits, such as MSFT or BRK.B.';
    var side = SIDES.some(function (x) { return x.value === f.side; }) ? f.side : null;
    if (!side) errors.side = 'Choose buy or sell.';
    var text = String(f.amount == null ? '' : f.amount).trim();
    var amount = parseAmount(text, cur, locale);
    if (!text) errors.amount = 'Enter an amount, in ' + cur + '.';
    else if (!(amount > 0) || !/^[^.]*(\.\d{1,2})?$/.test(text)) errors.amount = 'Enter an amount above zero, in ' + cur + ', such as 5,000.';
    if (Object.keys(errors).length) return { errors: errors };
    return { trade: { ticker: ticker, side: side, amount: amount } };
  }

  function tradeAmount(n, currency, locale) { return money(n, currency || 'USD', locale, true); }

  // The complete message a proposed trade drafts. It asks for the check and
  // a proposed journal entry; it places nothing and records nothing itself.
  function tradeMessage(trade, paths, currency, locale) {
    return ['I want to ' + trade.side + ' ' + tradeAmount(trade.amount, currency, locale) + ' of ' + trade.ticker
      + '. Check it against my risk limits first, and if it fits, add it to my decision journal as proposed.', '', notesLine(paths)].join('\n').trim();
  }

  function dashboardMessage(portfolio, risk, paths, locale) {
    var lines = ['Here is where my portfolio stands on my dashboard.', ''];
    if (portfolio) {
      var total = totalMarketValue(portfolio);
      lines.push('Total value: ' + money(total, currencyOf(portfolio, locale), locale) + ' (' + currencyOf(portfolio, locale) + '). Cash: ' + pct1(total > 0 ? totalCash(portfolio) / total : 0) + '.');
    }
    if (risk && regimeLabel(risk.strategyRegime)) lines.push('Strategy regime: ' + regimeLabel(risk.strategyRegime) + '.');
    if (portfolio && risk) {
      var found = breaches(riskChecks(portfolio, risk));
      if (found.length) { lines.push('Over my limits:'); found.forEach(function (b) { lines.push('- ' + breachSentence(b)); }); }
      else lines.push('Everything is inside my five limits.');
    }
    lines.push('', 'What should I look at first?', '', notesLine(paths));
    return lines.join('\n').trim();
  }

  // The setup interview, drafted for Lead Partner when a person leaves the
  // sample data behind.
  function setupMessage(paths, currencyGuess) {
    return ['I would like to set up my investments with you, replacing the sample data. Please interview me briefly, one question at a time:',
      '- which country I live in',
      '- my base currency' + (currencyGuess ? ' (I think it is ' + currencyGuess + ')' : ''),
      '- the accounts I hold, and what type each one is',
      '- whether I would like to import my positions from statements I can share',
      'Then replace the sample portfolio and decision journal with mine, keep my risk profile as it is, and remove the sample flag.',
      '', notesLine(paths)].join('\n').trim();
  }

  function breachMessage(found, paths) {
    return ['My dashboard shows allocations outside my risk limits:']
      .concat(found.map(function (b) { return '- ' + breachSentence(b); }))
      .concat(['', 'What would you change to bring them back inside, and in what order? Propose each change for my decision journal rather than making it.', '', notesLine(paths)])
      .join('\n').trim();
  }

  // ---------------------------------------------------------------------
  // Formatting, and the one note-reading helper the dashboard adds.
  // ---------------------------------------------------------------------

  function num(n) { return typeof n === 'number' && isFinite(n) ? String(n) : ''; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // The paths a dashboard note lists under `sources:`, block or flow list,
  // read here only to offer them as links when Rundock hands the view
  // nothing. Rundock itself decides what the view is given; this never
  // stands in for that.
  function sourcesListed(content) {
    var fm = frontmatterOf(content);
    if (!fm) return [];
    var lines = fm.text.split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var m = lines[i].match(/^sources:[ \t]*(.*)$/);
      if (!m) continue;
      var rest = m[1].trim();
      var out = [];
      if (rest.charAt(0) === '[') {
        rest.slice(1, rest.lastIndexOf(']')).split(',').forEach(function (s) { if (s.trim()) out.push(s.trim()); });
      } else if (rest === '') {
        for (var j = i + 1; j < lines.length; j += 1) {
          var item = lines[j].match(/^\s*-\s+(.*)$/);
          if (!item) break;
          out.push(item[1].trim());
        }
      }
      return out.map(function (s) { return unquote(s).replace(/^\[\[(.*)\]\]$/, '$1'); });
    }
    return [];
  }

  // ---------------------------------------------------------------------
  // The sources a dashboard is handed, sorted into the three notes it
  // draws. A source is recognised by its marker, not its name, so a person
  // may call their notes anything.
  // ---------------------------------------------------------------------

  var TITLES = { portfolio: 'Portfolio', 'risk-profile': 'Risk Profile', 'decision-journal': 'Decision Journal' };
  var SLOT_OF = { portfolio: 'portfolio', 'risk-profile': 'risk', 'decision-journal': 'journal' };

  function classifySources(list) {
    var out = { portfolio: null, risk: null, journal: null, problems: [], paths: [] };
    (list || []).forEach(function (src) {
      out.paths.push(src.path);
      if (typeof src.content !== 'string') {
        out.problems.push({ path: src.path, reason: 'Rundock did not hand it over (' + (src.refused || 'no reason given') + ')' });
        return;
      }
      var read = readNote(src.content);
      if (read.error) { out.problems.push({ path: src.path, reason: read.error }); return; }
      var slot = SLOT_OF[read.kind];
      if (!slot) { out.problems.push({ path: src.path, reason: 'it is marked "' + read.kind + '", and a dashboard draws a portfolio, a risk profile and a decision journal' }); return; }
      if (out[slot]) { out.problems.push({ path: src.path, reason: 'this dashboard already draws its ' + TITLES[read.kind] + ' from ' + out[slot].path }); return; }
      out[slot] = { path: src.path, content: src.content, data: read.data };
    });
    return out;
  }

  // What this view wrote, per source, so the `sources` message that
  // reports its own write back is recognised and does not redraw the
  // control the person is using.
  function createEchoes(limit) {
    var sent = {};
    var max = limit || 50;
    return {
      add: function (path, content) {
        var list = Object.prototype.hasOwnProperty.call(sent, path) ? sent[path] : (sent[path] = []);
        list.push(content);
        if (list.length > max) list.shift();
      },
      has: function (path, content) {
        return Object.prototype.hasOwnProperty.call(sent, path) && sent[path].indexOf(content) !== -1;
      },
    };
  }

  // ---------------------------------------------------------------------
  // The adapter: every message this view exchanges with Rundock, named in
  // one place. Named sources (`init.sources`, `sources`, `changeSource`)
  // and `ask` arrive in Rundock 0.15; if a name or a shape there moves,
  // this is the one place to change it.
  // ---------------------------------------------------------------------

  var MESSAGES = {
    ready: 'ready', resize: 'resize', error: 'error', open: 'open', change: 'change',
    changeSource: 'changeSource', ask: 'ask',
    init: 'init', sources: 'sources', refused: 'refused',
  };

  // Refusals Rundock itself shows the person, in its own bar or refusal line
  // above the view, for a click-gated request (open, openExternal, ask). The
  // view stays quiet about these, or the person reads it twice. Matched on
  // the reason text, which is what the host sends; if its wording changes,
  // this list is the one place to change. Every other refusal (a save, a
  // change, a source, or an ask Rundock does not show: an undeclared agent,
  // one not on the team, an embedded view) is still the view's to explain.
  var HOST_SHOWN_OF = ['open', 'openExternal', 'ask'];
  var HOST_SHOWN_REASONS = [
    'Rundock stopped this because it did not come from your click',
    'you dismissed this in Rundock',
    'Rundock is already asking you about another request',
  ];
  function hostShowsRefusal(refusal) {
    return !!refusal && HOST_SHOWN_OF.indexOf(refusal.of) !== -1 && HOST_SHOWN_REASONS.indexOf(String(refusal.reason).trim()) !== -1;
  }

  function normalizeSources(list) {
    if (!Array.isArray(list)) return null;
    return list.filter(function (s) { return s && typeof s === 'object' && typeof s.path === 'string'; }).map(function (s) {
      return typeof s.content === 'string' ? { path: s.path, content: s.content } : { path: s.path, refused: String(s.refused || 'not handed over') };
    });
  }

  function createHost(win) {
    var handlers = { init: [], sources: [], refused: [] };
    // A wildcard target, because this frame's own origin is opaque and it
    // cannot know the host's.
    var post = function (message) { win.parent.postMessage(message, '*'); };
    var emit = function (type, value) { handlers[type].forEach(function (fn) { fn(value); }); };
    win.addEventListener('message', function (event) {
      if (event.source !== win.parent) return;
      var data = event.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      if (data.type === MESSAGES.init) {
        // A Rundock without named sources sends no `sources` field, which
        // is not an empty list: null says "this Rundock cannot hand a view
        // other files", [] says "it handed none".
        emit('init', { path: String(data.path || ''), content: data.content, theme: data.theme, sources: normalizeSources(data.sources) });
      } else if (data.type === MESSAGES.sources) {
        emit('sources', normalizeSources(data.sources) || []);
      } else if (data.type === MESSAGES.refused) {
        emit('refused', { of: String(data.of || ''), reason: String(data.reason || '') });
      }
    });
    return {
      on: function (type, fn) { handlers[type].push(fn); },
      ready: function () { post({ type: MESSAGES.ready }); },
      resize: function (height) { post({ type: MESSAGES.resize, height: height }); },
      error: function (message) { post({ type: MESSAGES.error, message: message }); },
      open: function (target) { post({ type: MESSAGES.open, target: target }); },
      change: function (content) { post({ type: MESSAGES.change, content: content }); },
      changeSource: function (source, content) { post({ type: MESSAGES.changeSource, source: source, content: content }); },
      ask: function (agent, message) { post({ type: MESSAGES.ask, agent: agent, message: message }); },
    };
  }

  // ---------------------------------------------------------------------
  // The view. Every control and container is Rundock UI; only the donut
  // and its legend are drawn here, inside a Rundock UI canvas.
  // ---------------------------------------------------------------------

  var LEAD = 'lead-partner';
  var DASHBOARD_PATH = 'Investments/Investment Dashboard.md';
  var LIMIT_FIELDS = [
    { key: 'maximumSinglePositionFraction', label: 'Max single position', unset: 1 },
    { key: 'maximumSectorFraction', label: 'Max sector concentration', unset: 1 },
    { key: 'maximumAccountFraction', label: 'Max single account exposure', unset: 1 },
    { key: 'minimumCashReserveFraction', label: 'Min cash reserve', unset: 0 },
    { key: 'maximumIlliquidFraction', label: 'Max illiquid assets', unset: 1 },
  ];
  var TAX_FIELDS = [
    { key: 'preferTaxAdvantagedForDividends', label: 'Route dividends to tax-advantaged accounts' },
    { key: 'avoidShortTermGains', label: 'Avoid short-term capital gains' },
  ];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function boot(win) {
    var d = win.document;
    var ui = win.Rundock && win.Rundock.ui;
    var host = createHost(win);
    var echoes = createEchoes();
    // The person's locale, which writes every amount and picks a new
    // portfolio's currency.
    var nav = win.navigator || {};
    var LOCALE = (nav.languages && nav.languages[0]) || nav.language || 'en-US';
    var s = null;
    var slots = {};

    function h(tag, className, text) {
      var node = d.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function fill(slot, node) {
      if (!slot) return;
      slot.textContent = '';
      if (node) slot.appendChild(node);
    }
    function resize() {
      var doc = d.documentElement;
      host.resize(Math.ceil(Math.max(doc ? doc.scrollHeight : 0, d.body ? d.body.scrollHeight : 0)));
    }
    function sectionLabel(text) { return h('div', 'ip-section-label', text); }
    function portfolio() { return s.portfolio && s.portfolio.data; }
    function cur() { return currencyOf(portfolio(), LOCALE); }
    function fmt(n, exact) { return money(n, cur(), LOCALE, exact); }
    function risk() { return s.risk && s.risk.data; }
    function journal() { return s.journal && s.journal.data; }

    // Every edit is written as it is made: the whole note, changed only in
    // its data block, handed to Rundock, which writes once the edits pause
    // through the guarded save its editors use. No Save button.
    function write(slot, next, opts) {
      var src = s[slot];
      next.updatedAt = new Date().toISOString();
      // The first edit makes the notes the person's own: the sample flag
      // goes, and the first-run banner with it. Undoing a start-empty puts
      // the sample back exactly, which is the one write that keeps it.
      if (!(opts && opts.keepSample)) delete next.sample;
      var content = writeNote(src.content, next);
      src.content = content;
      src.data = next;
      if (s.mode === 'dashboard') {
        echoes.add(src.path, content);
        host.changeSource(src.path, content);
        // Whatever made the edit, a portfolio that stops being the sample
        // loses its banner at once, so its currency control never outlives it.
        if (slot === 'portfolio' && slots.banner) drawBanner();
      } else {
        s.content = content;
        host.change(content);
      }
    }

    // Asking drafts, and the person sends or not. The click is the
    // person's, so this is only ever called from a click handler.
    function ask(message, slot) {
      s.askSlot = slot;
      fill(slot, null);
      host.ask(LEAD, message);
    }
    function askSlot() { return h('div', 'ip-ask-note'); }

    // ---- the pieces --------------------------------------------------------

    // Undo instead of a confirm: the change is made, and a short-lived line
    // says what happened with an Undo beside it, where the change was made.
    // Focus moves to Undo when the control that acted is gone.
    var UNDO_MS = 8000;
    function offerUndo(slot, message, undo, moveFocus) {
      if (s.undoTimer) win.clearTimeout(s.undoTimer);
      if (s.undoSlot && s.undoSlot !== slot) fill(s.undoSlot, null);
      var button = ui.button({
        label: 'Undo', variant: 'secondary',
        onClick: function () { win.clearTimeout(s.undoTimer); fill(slot, null); s.undoSlot = null; undo(); resize(); },
      });
      button.classList.add('ip-undo');
      fill(slot, ui.alert({ tone: 'success', message: message, action: button }));
      s.undoSlot = slot;
      s.undoTimer = win.setTimeout(function () { if (slot.contains(button)) fill(slot, null); resize(); }, UNDO_MS);
      if (moveFocus) button.focus();
      resize();
      return button;
    }

    // The currency beside the total: a select of the common ones, and Other
    // for any code this runtime knows. Changing it relabels, never converts.
    function setCurrency(code) {
      var before = clone(portfolio());
      var was = cur();
      if (code === was) return;
      write('portfolio', relabelCurrency(portfolio(), code));
      s.currencyOther = false;
      s.currencyOpen = false;
      portfolioChanged();
      drawTradeForm();
      drawPositions();
      var toggle = d.getElementById('ip-currency-toggle');
      if (toggle) toggle.focus();
      offerUndo(slots.statsUndo, 'Currency set to ' + code + '. Every amount is relabelled; nothing was converted.', function () {
        write('portfolio', before, { keepSample: isSample(before) });
        portfolioChanged();
        drawTradeForm();
        drawPositions();
      });
    }
    // The currency beside the total is a small button ("· GBP ▾", or just
    // "▾" when the symbol already names its country) that opens the picker
    // in place. While the sample banner is up, its Start empty currency is
    // the only currency control on screen, so this is plain text then.
    function setCurrencyOpen(open, focus) {
      s.currencyOpen = open;
      s.currencyOther = false;
      drawStats();
      resize();
      if (!focus) return;
      var target = d.getElementById(open ? 'ip-currency' : 'ip-currency-toggle');
      if (target) target.focus();
    }
    function currencyToggle() {
      var code = cur();
      var shown = currencyNeedsCode(code, LOCALE) ? ' · ' + code : '';
      if (isSample(portfolio())) return shown ? h('span', 'ip-currency-code', shown) : null;
      var b = h('button', 'ip-currency-toggle', shown + ' ▾');
      b.type = 'button';
      b.id = 'ip-currency-toggle';
      b.setAttribute('aria-label', 'Currency: ' + code + '. Change currency');
      b.setAttribute('aria-expanded', s.currencyOpen ? 'true' : 'false');
      b.setAttribute('aria-controls', 'ip-currency-picker');
      b.addEventListener('click', function () { setCurrencyOpen(!s.currencyOpen, true); });
      return b;
    }
    function currencyControl() {
      var current = cur();
      var codes = COMMON_CURRENCIES.slice();
      if (codes.indexOf(current) === -1) codes.push(current);
      var options = codes.map(function (c) { return { value: c, label: c }; }).concat([{ value: 'other', label: 'Other…' }]);
      var select = ui.select({
        options: options, value: s.currencyOther ? 'other' : current,
        onChange: function (value) {
          if (value === 'other') { s.currencyOther = true; drawStats(); var o = d.getElementById('ip-currency-other'); if (o) o.focus(); return; }
          setCurrency(value);
        },
      });
      select.querySelector('select').id = 'ip-currency';
      var box = h('div', 'ip-currency');
      box.id = 'ip-currency-picker';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Currency');
      box.appendChild(ui.field({ label: 'Currency', control: select, help: 'One currency for the whole portfolio, with no conversion. Changing it relabels every amount; nothing is converted.' }));
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && event.target.id !== 'ip-currency-other') { event.preventDefault(); setCurrencyOpen(false, true); }
      });
      if (s.currencyOther) {
        var code = ui.input({ placeholder: 'BRL', label: 'Currency code' });
        code.id = 'ip-currency-other';
        code.setAttribute('autocomplete', 'off');
        code.maxLength = 3;
        var other = ui.field({ label: 'Currency code', control: code, help: 'Any three-letter code, such as BRL or MXN.' });
        var use = function () {
          var value = String(code.value).trim().toUpperCase();
          if (!isCurrencyCode(value)) { other.setError(value ? value + ' is not a currency code Rundock knows. Try one such as BRL or MXN.' : 'Enter a three-letter code, such as BRL.'); code.focus(); return; }
          setCurrency(value);
        };
        code.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); use(); }
          if (event.key === 'Escape') { event.preventDefault(); s.currencyOther = false; drawStats(); var sel = d.getElementById('ip-currency'); if (sel) sel.focus(); }
        });
        var row = h('div', 'ip-currency-other');
        row.appendChild(other);
        row.appendChild(ui.button({ label: 'Use', variant: 'secondary', onClick: use }));
        box.appendChild(row);
      }
      box.appendChild(ui.button({ label: 'Done', variant: 'secondary', onClick: function () { setCurrencyOpen(false, true); } }));
      return box;
    }

    // First run: while the portfolio is still the sample, say so, and offer
    // the two ways out. Setting up drafts a short interview for Lead
    // Partner; starting empty blanks the portfolio and journal in the chosen
    // currency, keeps the risk profile's defaults, and offers Undo.
    function drawBanner() {
      if (!slots.banner) return;
      if (!isSample(portfolio())) { if (!slots.banner.querySelector('.ip-undo')) fill(slots.banner, null); return; }
      var body = h('div', 'ip-banner');
      body.appendChild(h('strong', null, 'This is sample data.'));
      body.appendChild(h('p', 'ip-banner-text', 'The accounts, positions and decisions below are invented, so you can see the dashboard working. Set it up with your own, or start from nothing.'));
      var row = h('div', 'ip-banner-actions');
      var note = askSlot();
      var start = ui.select({
        label: 'Currency to start in',
        options: COMMON_CURRENCIES.map(function (c) { return { value: c, label: c }; }),
        value: s.startCurrency || defaultCurrency(LOCALE),
        onChange: function (v) { s.startCurrency = v; },
      });
      start.querySelector('select').id = 'ip-start-currency';
      // Secondary, so the screen keeps one primary action: the alert's Ask
      // Lead Partner while anything is over, Propose a trade otherwise.
      row.appendChild(ui.button({ label: 'Set up with Lead Partner', variant: 'secondary', onClick: function () { ask(setupMessage(s.paths, s.startCurrency || defaultCurrency(LOCALE)), note); } }));
      row.appendChild(ui.button({ label: 'Start empty', variant: 'secondary', onClick: function () { startEmpty(start.querySelector('select').value); } }));
      var currencyLabel = h('label', 'ip-banner-currency', 'in ');
      currencyLabel.setAttribute('for', 'ip-start-currency');
      row.appendChild(currencyLabel);
      row.appendChild(start);
      body.appendChild(row);
      body.appendChild(note);
      fill(slots.banner, ui.alert({ tone: 'attention', message: body }));
    }

    function startEmpty(currency) {
      var before = { portfolio: clone(portfolio()), journal: s.journal ? clone(journal()) : null };
      write('portfolio', emptyPortfolio(currency));
      if (s.journal) write('journal', emptyJournal());
      render();
      offerUndo(slots.banner, 'Started empty in ' + currency + '. Your portfolio and decision journal are blank; your risk profile keeps its defaults.', function () {
        write('portfolio', before.portfolio, { keepSample: true });
        if (before.journal && s.journal) write('journal', before.journal, { keepSample: true });
        render();
      }, true);
    }

    function drawStats() {
      var row = h('div', 'ip-stats');
      var p = portfolio();
      var r = risk();
      if (p) {
        var total = totalMarketValue(p);
        var cash = totalCash(p);
        var totalTile = ui.stat({ label: 'Total portfolio value', value: fmt(total) });
        var toggle = currencyToggle();
        if (toggle) totalTile.querySelector('.rui-stat-value').appendChild(toggle);
        if (s.currencyOpen && !isSample(portfolio())) totalTile.appendChild(currencyControl());
        row.appendChild(totalTile);
        row.appendChild(ui.stat({ label: 'Total cash', value: pct1(total > 0 ? cash / total : 0), delta: fmt(cash) }));
      }
      if (r) {
        var regime = regimeLabel(r.strategyRegime);
        row.appendChild(ui.stat({ label: 'Active regime', value: regime ? ui.chip({ tone: 'accent', label: regime }) : 'Not set' }));
      }
      if (s.mode === 'dashboard') {
        slots.trade = h('div', 'ip-trade');
        row.appendChild(slots.trade);
        drawTradeButton();
      }
      fill(slots.stats, row);
      if (!slots.statsUndo) slots.statsUndo = h('div', 'ip-undo-slot');
      if (!slots.statsUndo.parentNode && slots.stats.parentNode) slots.stats.parentNode.insertBefore(slots.statsUndo, slots.stats.nextSibling);
    }

    function overLimit() {
      var p = portfolio();
      var r = risk();
      return !!(p && r && breaches(riskChecks(p, r)).length);
    }

    // Propose a trade is the primary action until something is over a
    // limit; then the alert's Ask Lead Partner is, and this steps back to
    // secondary. Redrawn whenever the check can change.
    function drawTradeButton() {
      if (!slots.trade) return;
      var button = ui.button({
        label: '+ Propose a trade', variant: overLimit() ? 'secondary' : 'primary',
        onClick: function () { setTradeOpen(!s.tradeForm.open); },
      });
      button.setAttribute('aria-expanded', s.tradeForm.open ? 'true' : 'false');
      button.setAttribute('aria-controls', 'ip-trade-form');
      button.id = 'ip-trade-button';
      var hadFocus = d.activeElement && d.activeElement.id === 'ip-trade-button';
      fill(slots.trade, button);
      if (hadFocus) button.focus();
    }

    function setTradeOpen(open, focusBack) {
      s.tradeForm.open = open;
      if (!open) s.tradeForm.errors = {};
      drawTradeButton();
      drawTradeForm();
      resize();
      if (open) { var first = d.getElementById('ip-trade-ticker'); if (first) first.focus(); }
      else if (focusBack) { var b = d.getElementById('ip-trade-button'); if (b) b.focus(); }
    }

    // The inline form beneath the top row: a ticker, buy or sell, and an
    // amount. It drafts a message to Lead Partner through the same ask as
    // everything else, and does nothing else: it never sends, never writes
    // the journal, never places anything. Escape cancels.
    function drawTradeForm() {
      if (!slots.tradeForm) return;
      var t = s.tradeForm;
      if (!t.open) { fill(slots.tradeForm, null); return; }
      var errors = t.errors || {};
      // A group, not a <form>: the frame is sandboxed without allow-forms,
      // which blocks form submission before its submit event ever fires, so
      // the draft is started directly, by the button and by Enter.
      var form = h('div', 'ip-trade-form');
      form.id = 'ip-trade-form';
      form.setAttribute('role', 'group');
      form.setAttribute('aria-label', 'Propose a trade');

      var ticker = ui.input({ value: t.ticker, placeholder: 'MSFT', onChange: function (v) { t.ticker = v; } });
      ticker.id = 'ip-trade-ticker';
      ticker.setAttribute('autocomplete', 'off');
      ticker.setAttribute('spellcheck', 'false');
      var tickerField = ui.field({ label: 'Ticker', control: ticker, error: errors.ticker || null });

      // Buy or sell is a one-line segmented choice: Rundock UI's tabs, the
      // same pattern Rundock's own mode toggle uses for a choice of two. It
      // always holds one side (Buy until changed), and arrows move it. A
      // field cannot wrap it (it holds no input), so its label and any error
      // are wired here the way a field wires them.
      var side = h('div', 'rui-field ip-trade-side');
      var sideLabel = h('span', 'rui-field-label', 'Buy or sell');
      sideLabel.id = 'ip-trade-side-label';
      var group = ui.tabs({ label: 'Buy or sell', options: SIDES, value: t.side, onChange: function (v) { t.side = v; } });
      group.removeAttribute('aria-label');
      group.setAttribute('aria-labelledby', sideLabel.id);
      var sideError = h('span', 'rui-field-error-text', errors.side || '');
      sideError.id = 'ip-trade-side-error';
      sideError.hidden = !errors.side;
      if (errors.side) group.setAttribute('aria-describedby', sideError.id);
      side.appendChild(sideLabel);
      side.appendChild(group);
      side.appendChild(sideError);

      var amount = ui.input({ type: 'number', value: t.amount, placeholder: '5,000', onChange: function (v) { t.amount = v; } });
      amount.id = 'ip-trade-amount';
      amount.setAttribute('autocomplete', 'off');
      var amountField = ui.field({ label: 'Amount (' + cur() + ')', control: amount, help: 'The value to buy or sell, in ' + cur() + ', not a number of shares.', error: errors.amount || null });

      var fields = h('div', 'ip-trade-fields');
      fields.appendChild(tickerField);
      fields.appendChild(side);
      fields.appendChild(amountField);

      var note = askSlot();
      var actions = h('div', 'ip-trade-actions');
      actions.appendChild(ui.button({ label: 'Draft for Lead Partner', variant: 'primary', onClick: function () { draft(); } }));
      actions.appendChild(ui.button({ label: 'Cancel', variant: 'secondary', onClick: function () { setTradeOpen(false, true); } }));

      form.appendChild(fields);
      form.appendChild(actions);
      form.appendChild(h('p', 'ip-caption', 'Lead Partner checks it against your limits and proposes it for your journal. Nothing is placed, and nothing is sent until you send it.'));
      form.appendChild(note);
      function draft() {
        var checked = checkTrade(t, cur(), LOCALE);
        if (checked.errors) {
          t.errors = checked.errors;
          drawTradeForm();
          resize();
          var firstBad = ['ticker', 'side', 'amount'].filter(function (k) { return checked.errors[k]; })[0];
          var target = firstBad === 'side' ? d.querySelector('#ip-trade-form [role=tab][tabindex="0"]') : d.getElementById('ip-trade-' + firstBad);
          if (target) target.focus();
          return;
        }
        t.errors = {};
        drawTradeForm();
        ask(tradeMessage(checked.trade, s.paths, cur(), LOCALE), d.querySelector('#ip-trade-form .ip-ask-note'));
      }
      form.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); setTradeOpen(false, true); return; }
        // Enter in a text field drafts, as it would submit a form.
        if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); draft(); }
      });
      fill(slots.tradeForm, ui.card({ title: 'Propose a trade', children: form }));
    }

    function drawAlert() {
      var p = portfolio();
      var r = risk();
      if (!slots.alert) return;
      var found = p && r ? breaches(riskChecks(p, r)) : [];
      // One Ask Lead Partner on the screen, always: the alert's while
      // something is over a limit, the header's otherwise.
      drawHeaderAsk(found.length === 0);
      drawTradeButton();
      if (!p || !r) { fill(slots.alert, null); return; }
      // Nothing held is neither inside nor outside a limit, so say nothing.
      if (totalMarketValue(p) <= 0) { fill(slots.alert, null); return; }
      if (!found.length) {
        fill(slots.alert, ui.alert({ tone: 'success', message: 'Within limits: every allocation is inside the risk limits you have set.' }));
        return;
      }
      var body = h('div');
      body.appendChild(h('strong', null, found.length === 1 ? 'Over limit: one allocation is outside your risk limits.' : 'Over limit: ' + found.length + ' allocations are outside your risk limits.'));
      var list = h('ul', 'ip-breaches');
      found.forEach(function (b) { list.appendChild(h('li', null, breachSentence(b))); });
      body.appendChild(list);
      var note = askSlot();
      body.appendChild(note);
      fill(slots.alert, ui.alert({
        tone: 'attention', message: body,
        // The primary action while anything is over a limit.
        action: ui.button({ label: 'Ask Lead Partner', variant: 'primary', onClick: function () { ask(breachMessage(found, s.paths), note); } }),
      }));
    }

    function drawAllocation(el, rows) {
      var size = 168;
      var radius = 66;
      var stroke = 22;
      var circumference = 2 * Math.PI * radius;
      var wrap = h('div', 'ip-donut-wrap');
      var svg = d.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', 'ip-donut');
      var colors = rows.map(function (r, i) { return r.label === CASH ? 'var(--text-3)' : 'var(--chart-' + ((i % 5) + 1) + ')'; });
      var track = d.createElementNS(SVG_NS, 'circle');
      track.setAttribute('cx', String(size / 2));
      track.setAttribute('cy', String(size / 2));
      track.setAttribute('r', String(radius));
      track.setAttribute('fill', 'none');
      track.setAttribute('stroke-width', String(stroke));
      track.style.stroke = 'var(--elevated)';
      svg.appendChild(track);
      var at = 0;
      rows.forEach(function (r, i) {
        var length = r.fraction * circumference;
        // A hairline gap between slices, so two slices never read as one.
        var gap = rows.length > 1 && length > 3 ? 1.5 : 0;
        var arc = d.createElementNS(SVG_NS, 'circle');
        arc.setAttribute('cx', String(size / 2));
        arc.setAttribute('cy', String(size / 2));
        arc.setAttribute('r', String(radius));
        arc.setAttribute('fill', 'none');
        arc.setAttribute('stroke-width', String(stroke));
        arc.setAttribute('stroke-dasharray', (length - gap) + ' ' + (circumference - length + gap));
        arc.setAttribute('stroke-dashoffset', String(-at));
        arc.setAttribute('transform', 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')');
        arc.style.stroke = colors[i];
        svg.appendChild(arc);
        at += length;
      });
      wrap.appendChild(svg);
      var legend = h('div', 'ip-legend');
      rows.forEach(function (r, i) {
        var row = h('div', 'ip-legend-row');
        var dot = h('span', 'ip-legend-dot');
        dot.style.background = colors[i];
        row.appendChild(dot);
        row.appendChild(h('span', 'ip-legend-name', r.label));
        row.appendChild(h('span', 'ip-legend-value', fmt(r.value)));
        row.appendChild(h('span', 'ip-legend-pct', pct1(r.fraction)));
        legend.appendChild(row);
      });
      if (!rows.length) legend.appendChild(h('p', 'ip-caption', 'Nothing held yet.'));
      wrap.appendChild(legend);
      el.appendChild(wrap);
    }

    function drawDonut() {
      var rows = allocation(portfolio(), s.dimension);
      if (!rows.length) {
        var none = !(portfolio().accounts || []).length;
        var note = askSlot();
        var box = ui.emptyState({
          icon: 'inbox', title: 'Nothing to chart yet',
          subtitle: none ? 'No accounts yet. Add one, or ask Lead Partner to set up from your statements.'
            : 'Add a position or some cash to an account, and your allocation shows here.',
          children: s.mode === 'dashboard' && none ? [ui.button({ label: 'Set up with Lead Partner', variant: 'secondary', onClick: function () { ask(setupMessage(s.paths, cur()), note); } }), note] : null,
        });
        fill(slots.donut, box);
        return;
      }
      var dimension = DIMENSIONS.filter(function (x) { return x.value === s.dimension; })[0].label.toLowerCase();
      fill(slots.donut, ui.canvas({
        label: 'Allocation by ' + dimension + ': ' + (rows.length ? rows.map(function (r) { return r.label + ' ' + fmt(r.value) + ', ' + pct1(r.fraction); }).join('; ') : 'nothing held'),
        render: function (el) { drawAllocation(el, rows); },
      }));
    }

    // Account breakdown: every account as a meter against the single-account
    // limit, each name a button that opens it for editing in place, and
    // "+ Add account" at the end. Edits save as they are made.
    function accountLabel(a) {
      return a.name + (a.type && a.type !== a.name ? ' · ' + a.type : '');
    }
    function drawMeters() {
      var p = portfolio();
      if (!p || !slots.accounts) return;
      var limits = risk() ? limitsOf(risk()) : null;
      var box = h('div', 'ip-meters');
      var rows = accountBreakdown(p);
      rows.forEach(function (a, i) {
        if (s.editAccount && s.editAccount.index === i) { box.appendChild(accountEditor(i)); return; }
        var row = h('div', 'ip-account');
        var head = h('div', 'ip-account-head');
        var name = h('button', 'ip-account-name', a.name);
        name.type = 'button';
        name.id = 'ip-account-' + i;
        name.setAttribute('aria-label', 'Edit ' + a.name + (a.type ? ', ' + a.type : ''));
        name.addEventListener('click', function () { editAccount(i); });
        head.appendChild(name);
        if (a.type && a.type !== a.name) head.appendChild(h('span', 'ip-account-type', a.type));
        row.appendChild(head);
        var limit = limits ? limits.account : null;
        var over = limit !== null && limit !== undefined && a.fraction > limit;
        row.appendChild(ui.meter({
          label: fmt(a.value), value: a.fraction, limit: limit === null ? undefined : limit, format: pct1,
          ariaLabel: accountLabel(a) + ' · ' + fmt(a.value) + ', ' + pct1(a.fraction)
            + (limit !== null && limit !== undefined ? ' of a ' + pct1(limit) + ' maximum' + (over ? ', over the limit' : '') : ''),
        }));
        box.appendChild(row);
      });
      if (!rows.length) {
        box.appendChild(h('p', 'ip-caption', 'No accounts yet. Add one, or ask Lead Partner to set up from your statements.'));
      }
      var add = ui.button({ label: '+ Add account', variant: 'secondary', onClick: addAccount });
      add.id = 'ip-add-account';
      var actions = h('div', 'ip-account-actions');
      actions.appendChild(add);
      box.appendChild(actions);
      fill(slots.accounts, box);
      var total = totalMarketValue(p);
      if (total <= 0) { fill(slots.cash, h('p', 'ip-caption ip-empty-line', 'No cash held yet. Give an account a cash balance by opening it above.')); return; }
      fill(slots.cash, ui.meter({
        label: 'Cash · ' + fmt(totalCash(p)),
        value: total > 0 ? totalCash(p) / total : 0, limit: limits ? limits.cash : undefined, isMinimum: true, format: pct1,
      }));
    }

    function editAccount(i) {
      var a = portfolio().accounts[i];
      s.editAccount = { index: i, name: a.name, type: a.type || '', cash: num(a.cashBalance || 0), errors: {} };
      drawMeters();
      resize();
      var input = d.getElementById('ip-account-name-input');
      if (input) { input.focus(); input.select(); }
    }
    function closeAccountEditor() {
      var i = s.editAccount ? s.editAccount.index : null;
      s.editAccount = null;
      drawMeters();
      resize();
      var back = i === null ? null : d.getElementById('ip-account-' + i);
      if (back) back.focus();
    }

    // Save the editor's fields when they are valid; an invalid field shows
    // its reason and is not written.
    function saveAccountEdit() {
      var e = s.editAccount;
      var checked = checkAccount(portfolio(), e.index, e, cur(), LOCALE);
      e.errors = checked.errors || {};
      ['name', 'cash'].forEach(function (k) {
        var f = d.getElementById('ip-account-field-' + k);
        if (f && f.setError) f.setError(e.errors[k] || null);
      });
      if (checked.errors) return;
      var next = clone(portfolio());
      var acct = next.accounts[e.index];
      if (acct.name === checked.account.name && (acct.type || '') === checked.account.type && (acct.cashBalance || 0) === checked.account.cash) return;
      acct.name = checked.account.name;
      if (checked.account.type) acct.type = checked.account.type; else delete acct.type;
      acct.cashBalance = checked.account.cash;
      write('portfolio', next);
      drawStats();
      drawDonut();
      drawAlert();
      drawPositions();
      resize();
    }

    function accountEditor(i) {
      var e = s.editAccount;
      var a = portfolio().accounts[i];
      var box = h('div', 'ip-account-editor');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Edit account ' + a.name);
      var field = function (key, label, control, help) {
        control.id = 'ip-account-' + key + '-input';
        control.setAttribute('autocomplete', 'off');
        var f = ui.field({ label: label, control: control, help: help, error: e.errors[key] || null });
        f.id = 'ip-account-field-' + key;
        return f;
      };
      var name = ui.input({ value: e.name, onChange: function (v) { e.name = v; saveAccountEdit(); } });
      var type = ui.input({ value: e.type, placeholder: accountTypeSuggestions(cur())[0], onChange: function (v) { e.type = v; saveAccountEdit(); } });
      var list = h('datalist');
      list.id = 'ip-account-types';
      accountTypeSuggestions(cur()).forEach(function (t) { var o = d.createElement('option'); o.value = t; list.appendChild(o); });
      type.setAttribute('list', list.id);
      var cash = ui.input({ type: 'number', value: e.cash, onChange: function (v) { e.cash = v; saveAccountEdit(); } });
      var fields = h('div', 'ip-account-fields');
      fields.appendChild(field('name', 'Name', name));
      fields.appendChild(field('type', 'Type', type, 'Pick a suggestion or type your own.'));
      fields.appendChild(field('cash', 'Cash (' + cur() + ')', cash));
      box.appendChild(fields);
      box.appendChild(list);
      var actions = h('div', 'ip-account-actions');
      actions.appendChild(ui.button({ label: 'Done', variant: 'secondary', onClick: closeAccountEditor }));
      var block = accountRemoveBlock(a);
      var remove = ui.button({ label: 'Remove account', variant: 'danger', disabled: !!block, onClick: function () { removeAccount(i); } });
      actions.appendChild(remove);
      if (block) {
        var why = h('span', 'ip-caption ip-remove-why', block);
        why.id = 'ip-account-remove-why';
        remove.setAttribute('aria-describedby', why.id);
        actions.appendChild(why);
      }
      box.appendChild(actions);
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closeAccountEditor(); }
        if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); closeAccountEditor(); }
      });
      return box;
    }

    function addAccount() {
      var next = clone(portfolio());
      next.accounts = next.accounts || [];
      next.accounts.push({ name: newAccountName(next), cashBalance: 0, positions: [] });
      write('portfolio', next);
      portfolioChanged();
      drawPositions();
      editAccount(next.accounts.length - 1);
    }

    function removeAccount(i) {
      var before = clone(portfolio());
      var a = before.accounts[i];
      if (accountRemoveBlock(a)) return;
      var next = clone(before);
      next.accounts.splice(i, 1);
      s.editAccount = null;
      write('portfolio', next);
      portfolioChanged();
      drawPositions();
      offerUndo(slots.accountsUndo, 'Account removed: ' + a.name + (a.cashBalance ? ', with its ' + fmt(a.cashBalance) + ' of cash' : '') + '.', function () {
        var restore = clone(portfolio());
        restore.accounts.splice(Math.min(i, restore.accounts.length), 0, a);
        write('portfolio', restore);
        portfolioChanged();
        drawPositions();
        var back = d.getElementById('ip-account-' + Math.min(i, restore.accounts.length - 1));
        if (back) back.focus();
      }, true);
    }

    function portfolioChanged() {
      drawBanner();
      drawStats();
      drawDonut();
      drawMeters();
      drawAlert();
      resize();
    }
    function riskChanged() {
      drawMeters();
      drawAlert();
      resize();
    }

    function allocationCard() {
      var card = ui.card({
        title: 'Portfolio & allocation',
        actions: ui.tabs({
          label: 'Group allocation by', options: DIMENSIONS, value: s.dimension,
          onChange: function (value) { s.dimension = value; drawDonut(); resize(); },
        }),
      });
      slots.donut = h('div', 'ip-donut-slot');
      card.appendChild(slots.donut);
      card.appendChild(sectionLabel('Account breakdown'));
      slots.accounts = h('div');
      card.appendChild(slots.accounts);
      slots.accountsUndo = h('div', 'ip-undo-slot');
      card.appendChild(slots.accountsUndo);
      card.appendChild(sectionLabel('Cash drag'));
      slots.cash = h('div');
      card.appendChild(slots.cash);
      return card;
    }

    function riskPanel() {
      var r = risk();
      var c = r.constraints;
      var card = ui.card({ title: 'Risk control panel', subtitle: 'Changes save as you make them.' });
      var sliders = h('div', 'ip-sliders');
      LIMIT_FIELDS.forEach(function (f) {
        var value = isFraction(c[f.key]) ? c[f.key] : f.unset;
        sliders.appendChild(ui.slider({
          label: f.label, value: Math.round(value * 100), min: 0, max: 100, step: 1,
          format: function (v) { return pct1(v / 100); },
          onChange: function (v) {
            var next = clone(risk());
            next.constraints[f.key] = Math.round(v) / 100;
            write('risk', next);
            riskChanged();
          },
        }));
      });
      card.appendChild(sliders);
      card.appendChild(sectionLabel('Tax preferences'));
      var toggles = h('div', 'ip-toggles');
      TAX_FIELDS.forEach(function (f) {
        toggles.appendChild(ui.toggle({
          label: f.label, checked: !!(r.taxPreferences || {})[f.key],
          onChange: function (on) {
            var next = clone(risk());
            var tax = next.taxPreferences || {};
            tax[f.key] = on;
            next.taxPreferences = tax;
            write('risk', next);
          },
        }));
      });
      card.appendChild(toggles);
      card.appendChild(sectionLabel('Strategy regime'));
      card.appendChild(ui.optionList({
        label: 'Strategy regime', options: REGIMES, value: r.strategyRegime,
        onChange: function (value) {
          var next = clone(risk());
          next.strategyRegime = value;
          write('risk', next);
          drawStats();
          resize();
        },
      }));
      return card;
    }

    function boardCard() {
      var entries = journal().entries;
      // An entry with no decisionId still gets a card, named by its place.
      var idOf = function (e, i) { return e && e.decisionId ? String(e.decisionId) : 'entry-' + i; };
      var card = ui.card({ title: 'Decision board', actions: h('span', 'ip-hint', 'Move a card with its menu, or drag it.') });
      if (!entries.length) {
        card.appendChild(ui.emptyState({
          icon: 'inbox', title: 'No decisions yet',
          subtitle: 'Propose a trade, or ask Lead Partner to review a position; its proposals land here as Proposed, for you to move on.',
        }));
        return card;
      }
      card.appendChild(ui.board({
        columns: STATUSES.map(function (status) {
          return {
            id: status, title: cap(status),
            cards: entries.map(function (e, i) { return { e: e, i: i }; })
              .filter(function (x) { return x.e && x.e.status === status; })
              .map(function (x) { return { id: idOf(x.e, x.i), title: x.e.ticker + ': ' + x.e.action, meta: x.e.thesis || '' }; }),
          };
        }),
        onCardMove: function (id, to) {
          var next = clone(journal());
          var entry = next.entries.filter(function (e, i) { return idOf(e, i) === id; })[0];
          if (!entry) return;
          entry.status = to;
          entry.updatedAt = new Date().toISOString();
          write('journal', next);
        },
      }));
      return card;
    }

    // The quiet ask in the header, for when the alert has none to offer.
    function drawHeaderAsk(show) {
      if (!slots.headerAsk) return;
      if (!show) { fill(slots.headerAsk, null); return; }
      var box = h('div', 'ip-header-ask');
      var note = askSlot();
      var button = ui.button({ label: 'Ask Lead Partner', variant: 'secondary', onClick: function () { ask(dashboardMessage(portfolio(), risk(), s.paths, LOCALE), note); } });
      button.title = 'Opens a new conversation with Lead Partner, with a summary of this dashboard in the message box. Nothing is sent until you send it.';
      box.appendChild(button);
      box.appendChild(note);
      fill(slots.headerAsk, box);
    }

    function drawPositions() {
      if (!slots.positions) return;
      fill(slots.positions, positionsCard());
    }

    // Where position i of the flat list lives: its account and its place.
    function locate(p, i) {
      var n = 0;
      for (var a = 0; a < (p.accounts || []).length; a += 1) {
        var len = (p.accounts[a].positions || []).length;
        if (i < n + len) return { account: a, index: i - n };
        n += len;
      }
      return null;
    }
    function flatIndex(p, account, index) {
      var n = 0;
      for (var a = 0; a < account; a += 1) n += (p.accounts[a].positions || []).length;
      return n + index;
    }

    function movePosition(i, toAccount) {
      var next = clone(portfolio());
      var at = locate(next, i);
      if (!at || at.account === toAccount || !next.accounts[toAccount]) return;
      var moved = next.accounts[at.account].positions.splice(at.index, 1)[0];
      next.accounts[toAccount].positions = next.accounts[toAccount].positions || [];
      next.accounts[toAccount].positions.push(moved);
      write('portfolio', next);
      portfolioChanged();
      drawPositions();
      var menuBtn = d.getElementById('ip-pos-menu-' + flatIndex(next, toAccount, next.accounts[toAccount].positions.length - 1));
      if (menuBtn) menuBtn.focus();
      if (slots.positionsStatus) slots.positionsStatus.textContent = 'Moved ' + moved.ticker + ' to ' + next.accounts[toAccount].name + '.';
    }

    function removePosition(i) {
      var next = clone(portfolio());
      var at = locate(next, i);
      if (!at) return;
      var account = next.accounts[at.account];
      var removed = account.positions.splice(at.index, 1)[0];
      write('portfolio', next);
      portfolioChanged();
      drawPositions();
      offerUndo(slots.positionsUndo, 'Position removed: ' + removed.ticker + ' from ' + account.name + '.', function () {
        var restore = clone(portfolio());
        var target = restore.accounts[at.account] && restore.accounts[at.account].name === account.name ? restore.accounts[at.account] : null;
        if (!target) return;
        target.positions = target.positions || [];
        target.positions.splice(Math.min(at.index, target.positions.length), 0, removed);
        write('portfolio', restore);
        portfolioChanged();
        drawPositions();
        var back = d.getElementById('ip-pos-menu-' + flatIndex(restore, at.account, Math.min(at.index, target.positions.length - 1)));
        if (back) back.focus();
      }, true);
    }

    // The Add position row: ticker, account, quantity and price, with the
    // category fields defaulted and editable. What is typed survives a
    // redraw; a mistake is shown on its own field.
    function addPositionRow() {
      var p = portfolio();
      var form = s.addPosition || (s.addPosition = { ticker: '', account: '0', quantity: '', price: '', errors: {} });
      if (!form.assetClass) { var defaults = defaultCategories(LOCALE); form.assetClass = defaults.assetClass; form.sector = defaults.sector; form.geography = defaults.geography; }
      if (!p.accounts[Number(form.account)]) form.account = '0';
      var box = h('div', 'ip-add-position');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Add a position');
      box.appendChild(h('div', 'ip-section-label ip-add-label', 'Add position'));
      var fields = {};
      var make = function (key, label, control, help) {
        var native = control.tagName === 'SELECT' || control.tagName === 'INPUT' ? control : control.querySelector('select, input');
        native.id = 'ip-newpos-' + key;
        native.setAttribute('autocomplete', 'off');
        fields[key] = ui.field({ label: label, control: control, help: help, error: form.errors[key] || null });
        return fields[key];
      };
      var text = function (key, placeholder, type) {
        return ui.input({ type: type, value: form[key], placeholder: placeholder, onChange: function (v) { form[key] = v; } });
      };
      var accountSelect = ui.select({
        options: p.accounts.map(function (a, i) { return { value: String(i), label: a.name }; }),
        value: form.account, onChange: function (v) { form.account = v; },
      });
      var main = h('div', 'ip-add-fields');
      main.appendChild(make('ticker', 'Ticker', text('ticker', 'VOD')));
      main.appendChild(make('account', 'Account', accountSelect));
      main.appendChild(make('quantity', 'Quantity', text('quantity', '100', 'number')));
      main.appendChild(make('price', 'Price (' + cur() + ')', text('price', '0.72', 'number')));
      var cats = h('div', 'ip-add-fields ip-add-cats');
      cats.appendChild(make('assetClass', 'Asset class', text('assetClass', 'Equity')));
      cats.appendChild(make('sector', 'Sector', text('sector', 'Unclassified')));
      cats.appendChild(make('geography', 'Geography', text('geography', 'Unclassified')));
      box.appendChild(main);
      box.appendChild(cats);
      // A fund is many holdings, so it counts toward neither the
      // single-position nor the sector limit; illiquid counts toward the
      // illiquid limit. Both are the risk check's own flags.
      var flags = h('div', 'ip-add-flags');
      flags.appendChild(ui.checkbox({ label: 'Fund (an index or bond fund, which holds many companies)', checked: !!form.fund, onChange: function (v) { form.fund = v; } }));
      flags.appendChild(ui.checkbox({ label: 'Illiquid (hard to sell quickly)', checked: !!form.illiquid, onChange: function (v) { form.illiquid = v; } }));
      flags.querySelectorAll('input')[0].id = 'ip-newpos-fund';
      flags.querySelectorAll('input')[1].id = 'ip-newpos-illiquid';
      box.appendChild(flags);
      var add = function () {
        var checked = checkPosition(portfolio(), form, cur(), LOCALE);
        form.errors = checked.errors || {};
        Object.keys(fields).forEach(function (k) { fields[k].setError(form.errors[k] || null); });
        if (checked.errors) {
          var first = ['ticker', 'account', 'quantity', 'price'].filter(function (k) { return checked.errors[k]; })[0];
          var el = d.getElementById('ip-newpos-' + first);
          if (el) el.focus();
          return;
        }
        var next = clone(portfolio());
        var account = next.accounts[checked.account];
        account.positions = account.positions || [];
        account.positions.push(checked.position);
        write('portfolio', next);
        s.addPosition = { ticker: '', account: form.account, quantity: '', price: '', assetClass: form.assetClass, sector: form.sector, geography: form.geography, fund: false, illiquid: false, errors: {} };
        portfolioChanged();
        drawPositions();
        if (slots.positionsStatus) slots.positionsStatus.textContent = 'Added ' + checked.position.ticker + ' to ' + account.name + '.';
        var again = d.getElementById('ip-newpos-ticker');
        if (again) again.focus();
      };
      var actions = h('div', 'ip-account-actions');
      actions.appendChild(ui.button({ label: 'Add position', variant: 'secondary', onClick: add }));
      actions.appendChild(ui.button({ label: 'Close', variant: 'secondary', onClick: function () { setAddPositionOpen(false); } }));
      actions.appendChild(h('span', 'ip-caption ip-remove-why', 'Asset class, sector and geography feed the allocation tabs; change them if the defaults are wrong.'));
      box.appendChild(actions);
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && event.target.tagName === 'INPUT' && event.target.type !== 'checkbox') { event.preventDefault(); add(); }
        if (event.key === 'Escape') { event.preventDefault(); setAddPositionOpen(false); }
      });
      return box;
    }

    // "+ Add position" opens the row in place, like "+ Add account"; Escape
    // or Close puts it away and returns focus to the button.
    function setAddPositionOpen(open) {
      s.addPositionOpen = open;
      drawPositions();
      resize();
      var target = d.getElementById(open ? 'ip-newpos-ticker' : 'ip-add-position-button');
      if (target) target.focus();
    }

    function positionsCard() {
      var p = portfolio();
      var flat = allPositions(p);
      var valueCells = [];
      var pricedCells = [];
      var priced = function (i) {
        var price = allPositions(portfolio())[i].position.currentPrice;
        fill(pricedCells[i], price && price.asOf ? ui.relativeTime({ iso: price.asOf, staleAfterMs: STALE_MS }) : h('span', 'ip-caption', 'Not priced'));
      };
      // Quantity and price read as text and open in place (Rundock UI's
      // editable table): the table checks the number, and this writes it.
      var saveCell = function (change) {
        var next = clone(portfolio());
        var position = allPositions(next)[change.row.i].position;
        if (change.key === 'quantity') position.quantity = change.value;
        else position.currentPrice = { amount: change.value, currency: cur(), asOf: new Date().toISOString() };
        write('portfolio', next);
        valueCells[change.row.i].textContent = fmt(marketValue(position));
        priced(change.row.i);
        portfolioChanged();
        return true;
      };
      var inRow = function (row) { return row.ticker + ' in ' + row.account; };
      // Rundock UI measures every column once, on first render, from what it
      // shows; Priced may later show wider than its first rows do, so it
      // names its widest: "Not priced", and a price gone stale for months.
      var pricedWidest = function () {
        return [h('span', 'ip-caption', 'Not priced'), ui.relativeTime({ iso: new Date(Date.now() - 334 * 24 * 60 * 60 * 1000).toISOString(), staleAfterMs: STALE_MS })];
      };
      var quantityText = function (v) { return typeof v === 'number' ? v.toLocaleString(LOCALE, { maximumFractionDigits: 8 }) : ''; };
      var priceText = function (v) { return typeof v === 'number' ? v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : 'Not set'; };
      var card = ui.card({ title: 'Positions', subtitle: 'Select a quantity or price to change it. Prices are entered by hand, in ' + cur() + ', and marked stale after a day.' });
      card.classList.add('ip-positions');
      slots.positionsStatus = h('div', 'rui-visually-hidden');
      slots.positionsStatus.setAttribute('role', 'status');
      card.appendChild(slots.positionsStatus);
      if (!(p.accounts || []).length) {
        card.appendChild(ui.emptyState({
          icon: 'inbox', title: 'No positions yet',
          subtitle: 'Add an account first, in Account breakdown, or ask Lead Partner to set up from your statements.',
        }));
        return card;
      }
      if (!flat.length) {
        card.appendChild(h('p', 'ip-caption ip-empty-line', 'No positions yet. Add one, or ask Lead Partner to add them from your statements.'));
      } else {
        card.appendChild(ui.table({
          caption: 'Positions: select a quantity or price to change it, or move or remove a position from its row menu',
          onEdit: saveCell,
          resizable: true,
          // The widths the person sets are kept by Rundock UI in the view's
          // own state that Rundock holds for this note, never in a note, so
          // they survive a redraw, a reload and a return.
          stateKey: 'positions',
          columns: [
            { key: 'ticker', label: 'Ticker' },
            // Account is the main column: it takes the card's spare room, so
            // the table fills its width with the row menu at the right edge.
            { key: 'account', label: 'Account', grow: true },
            { key: 'quantity', label: 'Quantity', numeric: true, format: quantityText, edit: { type: 'number', min: 0, label: inRow } },
            { key: 'price', label: 'Price (' + cur() + ')', numeric: true, format: priceText, edit: { type: 'number', min: 0, label: inRow } },
            { key: 'value', label: 'Market value', numeric: true, render: function (v, row) { valueCells[row.i] = h('span', null, fmt(marketValue(flat[row.i].position))); return valueCells[row.i]; } },
            { key: 'priced', label: 'Priced', widest: pricedWidest(), render: function (v, row) { pricedCells[row.i] = h('span'); priced(row.i); return pricedCells[row.i]; } },
            {
              // One quiet menu per row: move to another account, or remove
              // (with Undo). Nothing else lives here.
              key: 'actions', label: h('span', 'rui-visually-hidden', 'Actions'), render: function (v, row) {
                var items = p.accounts
                  .map(function (a, ai) { return { value: 'move:' + ai, label: 'Move to ' + a.name, ai: ai }; })
                  .filter(function (x) { return x.ai !== row.accountIndex; })
                  .map(function (x) { return { value: x.value, label: x.label }; });
                // A rule sets Remove apart from the moves, when there are any.
                items = items.concat(items.length ? [{ separator: true }] : [], [{ value: 'remove', label: 'Remove ' + row.ticker }]);
                var m = ui.menu({
                  label: 'Actions for ' + row.ticker + ' in ' + row.account, items: items,
                  onSelect: function (value) {
                    if (value === 'remove') removePosition(row.i);
                    else movePosition(row.i, Number(String(value).slice(5)));
                  },
                });
                m.querySelector('.rui-menu-btn').id = 'ip-pos-menu-' + row.i;
                return m;
              },
            },
          ],
          rows: flat.map(function (x, i) {
            var price = x.position.currentPrice;
            return {
              i: i, ticker: x.position.ticker, account: x.account.name, accountIndex: p.accounts.indexOf(x.account),
              quantity: x.position.quantity, price: price && typeof price.amount === 'number' ? price.amount : undefined,
            };
          }),
        }));
      }
      slots.positionsUndo = h('div', 'ip-undo-slot');
      card.appendChild(slots.positionsUndo);
      if (s.addPositionOpen) card.appendChild(addPositionRow());
      else {
        var open = ui.button({ label: '+ Add position', variant: 'secondary', onClick: function () { setAddPositionOpen(true); } });
        open.id = 'ip-add-position-button';
        var row = h('div', 'ip-account-actions ip-add-open');
        row.appendChild(open);
        card.appendChild(row);
      }
      return card;
    }

    function missingCard(title, what) {
      return ui.card({ title: title, children: ui.emptyState({ icon: 'inbox', title: 'No ' + what + ' listed', subtitle: 'Add your ' + what + ' note under sources: in this note to draw it here.' }) });
    }

    function openButtons(paths) {
      var row = h('div', 'ip-open-row');
      paths.forEach(function (p) {
        // Honoured by Rundock only after a click inside the view.
        row.appendChild(ui.button({ label: 'Open ' + p, variant: 'secondary', onClick: function () { host.open(p); } }));
      });
      return row;
    }

    // ---- the page ----------------------------------------------------------

    function page(title, subtitle, aside) {
      d.body.textContent = '';
      slots = {};
      var root = h('main', 'ip-root');
      var head = h('header', 'ip-head');
      var titles = h('div');
      titles.appendChild(h('h1', 'ip-title', title));
      if (subtitle) titles.appendChild(h('p', 'ip-subtitle', subtitle));
      head.appendChild(titles);
      if (aside) head.appendChild(aside);
      root.appendChild(head);
      slots.notices = h('div', 'ip-notices');
      root.appendChild(slots.notices);
      d.body.appendChild(root);
      return root;
    }

    function renderUnavailable(root) {
      var listed = sourcesListed(s.content);
      var title = s.sourcesList === null ? 'This Rundock cannot hand the dashboard its notes'
        : listed.length ? 'Rundock handed this view none of its notes' : 'This dashboard lists no notes';
      var subtitle = s.sourcesList === null
        ? 'The dashboard draws the notes listed under sources: in this note, which needs a Rundock with named sources. Until then, open each note on its own.'
        : listed.length ? 'Check that the Investment Partner extension is allowed to read the notes a dashboard lists, then reopen this note.'
          : 'List your portfolio, risk profile and decision journal under sources: in this note\'s frontmatter.';
      var box = ui.emptyState({ icon: 'inbox', title: title, subtitle: subtitle, children: listed.length ? openButtons(listed) : null });
      root.appendChild(box);
    }

    function renderDashboard() {
      var headerAsk = h('div');
      var root = page('Investment Partner', 'Lead Partner · Equity Analyst · Risk Manager', headerAsk);
      slots.headerAsk = headerAsk;
      slots.updated = h('p', 'ip-updated');
      slots.updated.setAttribute('role', 'status');
      root.querySelector('.ip-head > div').appendChild(slots.updated);
      drawUpdated();
      (s.problems || []).forEach(function (p) {
        slots.notices.appendChild(ui.alert({ tone: 'attention', message: p.path + ' is not drawn: ' + p.reason + '.' }));
      });
      if (!s.portfolio && !s.risk && !s.journal) { renderUnavailable(root); return; }
      slots.banner = h('div', 'ip-banner-slot');
      root.appendChild(slots.banner);
      slots.stats = h('div');
      root.appendChild(slots.stats);
      slots.tradeForm = h('div');
      root.appendChild(slots.tradeForm);
      slots.alert = h('div', 'ip-risk');
      root.appendChild(slots.alert);
      var grid = h('div', 'ip-grid');
      grid.appendChild(s.portfolio ? allocationCard() : missingCard('Portfolio & allocation', 'portfolio'));
      grid.appendChild(s.risk ? riskPanel() : missingCard('Risk control panel', 'risk profile'));
      root.appendChild(grid);
      root.appendChild(s.journal ? boardCard() : missingCard('Decision board', 'decision journal'));
      if (s.portfolio) {
        slots.positions = h('div');
        root.appendChild(slots.positions);
      }
      drawBanner();
      drawStats();
      drawTradeForm();
      if (s.portfolio) { drawDonut(); drawMeters(); drawPositions(); }
      drawAlert();
    }

    function renderNote() {
      var dashboardLink = ui.button({ label: 'Open the dashboard', variant: 'secondary', onClick: function () { host.open(DASHBOARD_PATH); } });
      var root = page(TITLES[s.kind], null, dashboardLink);
      if (s.kind === 'portfolio') {
        slots.stats = h('div');
        root.appendChild(slots.stats);
        root.appendChild(allocationCard());
        slots.positions = h('div');
        root.appendChild(slots.positions);
        drawPositions();
        root.appendChild(h('p', 'ip-caption', 'Your limits live in Risk Profile. The dashboard reads both notes and checks one against the other.'));
        drawStats();
        drawDonut();
        drawMeters();
      } else if (s.kind === 'risk-profile') {
        root.appendChild(riskPanel());
      } else {
        root.appendChild(boardCard());
      }
    }

    function render() {
      if (s.mode === 'dashboard') renderDashboard();
      else renderNote();
      resize();
    }

    // ---- Rundock's messages --------------------------------------------------

    function applySources(list) {
      var before = {};
      ['portfolio', 'risk', 'journal'].forEach(function (slot) { if (s[slot]) before[s[slot].path] = s[slot]; });
      s.sourcesList = list;
      var sorted = classifySources(list || []);
      // A redraw for someone else's change can carry an older copy of a
      // file this view has since written again. The newer write is still on
      // its way to disk, so the view keeps drawing and building on it.
      ['portfolio', 'risk', 'journal'].forEach(function (slot) {
        var got = sorted[slot];
        var mine = got && before[got.path];
        if (mine && mine.content !== got.content && echoes.has(got.path, got.content)) sorted[slot] = mine;
      });
      s.portfolio = sorted.portfolio;
      s.risk = sorted.risk;
      s.journal = sorted.journal;
      s.problems = sorted.problems;
      s.paths = sorted.paths;
      s.snapshot = (list || []).map(function (src) { return src.path + '\n' + (typeof src.content === 'string' ? 'c' + src.content : 'r' + src.refused); });
      render();
    }

    // Rundock reports every write back, this view's own included. A list
    // whose every file is what it was, or what this view last wrote, is
    // taken quietly, so a slider being dragged is never redrawn under the
    // pointer. Anything else (a change made elsewhere, a name added to or
    // removed from the note) redraws from the new list.
    function isEcho(list) {
      if (!s.snapshot || list.length !== s.snapshot.length) return false;
      return list.every(function (src, i) {
        if (src.path !== s.snapshot[i].split('\n')[0]) return false;
        var sig = src.path + '\n' + (typeof src.content === 'string' ? 'c' + src.content : 'r' + src.refused);
        if (sig === s.snapshot[i]) return true;
        return typeof src.content === 'string' && echoes.has(src.path, src.content);
      });
    }

    host.on('init', function (init) {
      if (!ui) {
        d.body.textContent = 'Investment Partner needs Rundock UI, which this Rundock does not provide.';
        host.error('Investment Partner needs Rundock UI, which arrives in Rundock 0.15');
        return;
      }
      var kind = kindOf(init.content);
      if (kind === DASHBOARD) {
        s = { mode: 'dashboard', kind: kind, path: init.path, content: init.content, dimension: 'assetClass',
          tradeForm: { open: false, ticker: '', side: 'buy', amount: '', errors: {} } };
        applySources(init.sources);
        return;
      }
      var read = readNote(init.content);
      if (read.error) {
        // Named to Rundock, which puts the note's ordinary view back with
        // this reason beside it. The note is still readable as markdown.
        d.body.textContent = 'Investment Partner cannot draw this note: ' + read.error + '.';
        host.error('Investment Partner: ' + read.error);
        return;
      }
      s = { mode: 'note', kind: read.kind, path: init.path, content: init.content, dimension: 'assetClass', paths: [init.path] };
      s[SLOT_OF[read.kind]] = { path: init.path, content: init.content, data: read.data };
      render();
    });

    host.on('sources', function (list) {
      if (!s || s.mode !== 'dashboard' || isEcho(list)) return;
      // Not this view's own write: someone else changed a note (Lead Partner,
      // an editor, a sync), and the dashboard says so quietly after redrawing.
      s.externalAt = new Date().toISOString();
      applySources(list);
      scheduleUpdated();
    });

    // "Updated just now" after a redraw this view did not cause, ageing into
    // "Updated 3 minutes ago".
    function drawUpdated() {
      if (!slots.updated || !s.externalAt) return;
      var age = Date.now() - new Date(s.externalAt).getTime();
      fill(slots.updated, age < 60000
        ? h('span', null, 'Updated just now, from a change made outside this dashboard.')
        : ui.relativeTime({ iso: s.externalAt, prefix: 'Updated' }));
    }
    function scheduleUpdated() {
      if (s.updatedTimer) win.clearTimeout(s.updatedTimer);
      s.updatedTimer = win.setTimeout(function () { drawUpdated(); if (Date.now() - new Date(s.externalAt).getTime() < 3600000) scheduleUpdated(); }, 30000);
    }

    // What did not happen, in words that match it: a refused open is not a
    // save, so it is never called one. Names this view sends come from the
    // adapter's table; openExternal, save and saveSource are never sent by
    // this view and are named only so a refusal of one still reads right.
    function refusalWords(refusal) {
      var why = ' (' + refusal.reason + ').';
      var of = refusal.of;
      if (of === MESSAGES.open || of === 'openExternal') return 'Not opened: Rundock did not open it' + why;
      if (of === 'save' || of === MESSAGES.change || of === 'saveSource' || of === MESSAGES.changeSource) {
        return 'Not saved: Rundock refused the write' + why;
      }
      return 'Rundock refused ' + of + why;
    }

    host.on('refused', function (refusal) {
      if (!ui || !s) return;
      if (hostShowsRefusal(refusal)) return;
      if (refusal.of === MESSAGES.ask) {
        fill(s.askSlot || slots.notices, ui.alert({ tone: 'attention', message: 'Not asked: Rundock did not open a conversation with Lead Partner (' + refusal.reason + ').' }));
      } else {
        slots.notices.appendChild(ui.alert({ tone: 'danger', message: refusalWords(refusal) }));
      }
      resize();
    });

    win.addEventListener('resize', function () { if (s) resize(); });
    host.ready();
  }

  return {
    MARKER: MARKER, KINDS: KINDS, STATUSES: STATUSES, STALE_MS: STALE_MS, REGIMES: REGIMES, DIMENSIONS: DIMENSIONS,
    DASHBOARD: DASHBOARD, MESSAGES: MESSAGES, HOST_SHOWN_REASONS: HOST_SHOWN_REASONS, hostShowsRefusal: hostShowsRefusal, LEAD: LEAD, DASHBOARD_PATH: DASHBOARD_PATH,
    kindOf: kindOf, dataBlock: dataBlock, readNote: readNote, writeNote: writeNote, shapeProblem: shapeProblem,
    sourcesListed: sourcesListed, classifySources: classifySources, createEchoes: createEchoes, createHost: createHost,
    marketValue: marketValue, isStale: isStale, allPositions: allPositions, totalCash: totalCash,
    totalMarketValue: totalMarketValue, groupSum: groupSum,
    largestSinglePositionFraction: largestSinglePositionFraction,
    largestSectorFraction: largestSectorFraction, cashReserveFraction: cashReserveFraction,
    accountBreakdown: accountBreakdown, allocation: allocation, holdings: holdings, limitsOf: limitsOf,
    riskChecks: riskChecks, breaches: breaches, breachSentence: breachSentence, regimeLabel: regimeLabel,
    pct1: pct1, money: money, SIDES: SIDES, checkTrade: checkTrade, tradeMessage: tradeMessage, dashboardMessage: dashboardMessage,
    COMMON_CURRENCIES: COMMON_CURRENCIES, currencyNeedsCode: currencyNeedsCode, defaultCurrency: defaultCurrency, isCurrencyCode: isCurrencyCode, currencyOf: currencyOf,
    parseAmount: parseAmount, isSample: isSample, emptyPortfolio: emptyPortfolio, emptyJournal: emptyJournal,
    accountTypeSuggestions: accountTypeSuggestions, newAccountName: newAccountName, checkAccount: checkAccount,
    accountRemoveBlock: accountRemoveBlock, checkPosition: checkPosition, defaultCategories: defaultCategories,
    relabelCurrency: relabelCurrency, setupMessage: setupMessage,
    breachMessage: breachMessage, boot: boot,
  };
}));
