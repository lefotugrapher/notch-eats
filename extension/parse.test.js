const assert = require("assert");
const { parse } = require("./parse.js");

const now = new Date("2026-11-08T19:20:00").getTime();
const orderPath = "/gb/orders/6f1c2a9e-1234-4abc-9def-0123456789ab";
const at = (h, m) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); };

// 1. keyword time of day, 12h
let r = parse({ text: "Preparing your order\nArriving at 7:45 PM\nHelp", headings: ["Preparing your order"], path: orderPath, now });
assert.equal(r.status, "Preparing"); assert.equal(r.etaAbsMs, at(19, 45)); assert.equal(r.done, false);

// 2. 24h clock (UK)
r = parse({ text: "On the way\nArrives by 19:50", headings: ["On the way"], path: orderPath, now });
assert.equal(r.status, "On the way"); assert.equal(r.etaAbsMs, at(19, 50));

// 3. range uses the upper bound, am/pm only on second half
r = parse({ text: "Order placed\nEstimated arrival 7:30 - 7:40 PM", headings: [], path: orderPath, now });
assert.equal(r.status, "Placed"); assert.equal(r.etaAbsMs, at(19, 40));

// 4. keywordless range line
r = parse({ text: "Heading your way\n7:30 – 7:40 PM", headings: [], path: orderPath, now });
assert.equal(r.etaAbsMs, at(19, 40)); assert.equal(r.status, "On the way");

// 5. duration
r = parse({ text: "Arrives in 12 min\nYour courier is on the way", headings: [], path: orderPath, now });
assert.equal(r.durMin, 12); assert.equal(r.status, "On the way");

// 6. duration range uses upper bound; standalone line allowed on order page
r = parse({ text: "Preparing your order\n15-25 min", headings: [], path: orderPath, now });
assert.equal(r.durMin, 25);

// 7. delivered / cancelled
r = parse({ text: "Your order was delivered\nEnjoy your meal", headings: ["Your order was delivered"], path: orderPath, now });
assert.equal(r.done, true); assert.equal(r.status, "Delivered");
r = parse({ text: "Your order was cancelled", headings: [], path: orderPath, now });
assert.equal(r.done, true); assert.equal(r.status, "Cancelled");

// 8. past midnight rolls to next day
const late = new Date("2026-11-08T23:50:00").getTime();
r = parse({ text: "On the way\nArriving at 12:10 AM", headings: [], path: orderPath, now: late });
assert.equal(r.etaAbsMs, new Date("2026-11-09T00:10:00").getTime());

// 9. not an order page: home page restaurant tiles must not trigger
assert.equal(parse({ text: "Pizza Place\n25-35 min\nBurger Joint\n15-25 min", headings: [], path: "/gb", now }), null);
// 10. home page with active-order banner (status + keyword ETA) does trigger
r = parse({ text: "Your order is on the way\nArriving at 7:45 PM", headings: [], path: "/gb", now });
assert.equal(r && r.status, "On the way");
// 11. delivered text on a non-order page is ignored
assert.equal(parse({ text: "Your order was delivered", headings: [], path: "/gb/account", now }), null);

// 12. shaped like the real grocery tracking page (all values made up)
const real = [
  "Uber Eats", "Help", "Example Mart Town", "Shopping completed", "Total: €15.45", "Order summary",
  "1234", "ALEX · 99XY1234", "ALEX is in a car", "Top-rated courier", "Send a message",
  "Follow on your phone", "Confirm delivery with PIN 1234",
  "After you get your order, tell the delivery person your PIN.", "Delivery details", "8 min away",
].join("\n");
r = parse({ text: real, headings: [], title: "Heading your way...", path: orderPath, now });
assert.equal(r.status, "On the way");
assert.equal(r.durMin, 8);
assert.equal(r.pin, "1234");
assert.equal(r.courier, "Alex");
assert.equal(r.vehicle, "car");
assert.equal(r.plate, "99XY1234");
assert.equal(r.store, "Example Mart Town");

// 13. PIN variants
assert.equal(parse({ text: "On the way\nArrives in 5 min\nYour PIN: 4821", path: orderPath, now }).pin, "4821");
assert.equal(parse({ text: "On the way\nArrives in 5 min\nShare code 4821 with courier", path: orderPath, now }).pin, null);

// 14. "Almost here" page has no minutes: still reported, as due now
r = parse({ text: "Almost here!\nArriving now\nTime to meet ALEX. Get your order, then share your PIN: 1234\nALEX is in a car", headings: ["Almost here!"], title: "Almost here!", path: orderPath, now });
assert.equal(r.status, "Arriving"); assert.equal(r.durMin, 0); assert.equal(r.pin, "1234");

// 15. promo "nearby" must not trigger Arriving; "Picking up your order" tab title is its own status
r = parse({
  text: "Uber Eats\nExample Mart Milk 1L\nTotal €14.61\nMastercard ····1234 (name)\nOrder placed\nBundle any nearby shop for €0 Delivery Fee\nArrives by 11:40 AM",
  headings: [], title: "Picking up your order...", path: orderPath, now: new Date("2026-11-13T11:00:00").getTime(),
});
assert.equal(r.status, "Picking up");
assert.equal(r.store, null, "payment line must not be taken as the store");
assert.equal(parse({ text: "Preparing\nBundle any nearby shop\nArrives in 9 min", path: orderPath, now }).status, "Preparing");
assert.equal(parse({ text: "Your courier is nearby\nArrives in 2 min", path: orderPath, now }).status, "Arriving");

// 16. shaped like the real "Picking up your order" page (all values made up)
const now2 = new Date("2026-11-13T11:00:00").getTime();
const at2 = (h, m) => { const d = new Date(now2); d.setHours(h, m, 0, 0); return d.getTime(); };
const real2 = [
  "Uber Eats", "Help", "Picking up your order...", "Arrives 11:23 - 11:40 AM",
  "Tell the delivery person how to find your door", "Add delivery instructions",
  "Example Mart Town", "We’ll update you here as your shopper works on your order",
  "Total: €14.61", "Order summary",
  "1234", "ALEX · On a bicycle", "Top-rated courier", "Send a message",
  "Follow on your phone", "Bundle any nearby shop for €0 Delivery Fee",
].join("\n");
r = parse({ text: real2, headings: ["Picking up your order..."], title: "Picking up your order...", path: orderPath, now: now2 });
assert.equal(r.status, "Picking up");
assert.equal(r.stage, 3);
assert.equal(r.headline, "Picking up your order");
assert.equal(r.etaAbsMs, at2(11, 40));
assert.equal(r.etaLowAbsMs, at2(11, 23));
assert.equal(r.courier, "Alex");
assert.equal(r.vehicle, "bicycle");
assert.equal(r.topRated, true);
assert.equal(r.store, "Example Mart Town");
assert.equal(r.total, "€14.61");
assert.equal(r.pin, "1234");

// 17. badge-only PIN layout (no "PIN" word)
r = parse({ text: "Picking up your order...\nArrives 11:23 - 11:40 AM\n4821\nALEX · On a bicycle", title: "Picking up your order...", path: orderPath, now: now2 });
assert.equal(r.pin, "4821");

console.log("parse tests passed");
