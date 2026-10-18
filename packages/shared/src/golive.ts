// The go-live rehearsal: the restaurant's hardest moments, run by the owner and cashier on their
// own devices before full payment starts. Each scenario says what to do and what passing means.

export const GOLIVE_SCENARIOS = ['menu', 'printers', 'mixed_order', 'split_bill', 'free_dish', 'cooked_cancel', 'printer_out', 'internet_off', 'day_end'] as const;
export type GoliveScenario = (typeof GOLIVE_SCENARIOS)[number];

export const GOLIVE_RESULTS = ['passed', 'failed', 'out_of_scope'] as const;
export type GoliveResult = (typeof GOLIVE_RESULTS)[number];

export const GOLIVE_TEXT: Record<GoliveScenario, { title: string; how: string; pass: string }> = {
  menu: {
    title: 'Menu check',
    how: 'Open the QR menu on a phone and the POS on the counter. Go through every category: names, prices, GST rates, photos and the station each dish goes to.',
    pass: 'Every dish has the right price, GST rate and station.',
  },
  printers: {
    title: 'A ticket at every printer',
    how: 'Send one dish to each station and print one bill, on the printers you will use in service.',
    pass: 'Each station printed only its dish, and the bill printed at the counter.',
  },
  mixed_order: {
    title: 'A mixed bar and kitchen order',
    how: 'Take an order with food and drinks for one table, the way a waiter would on a busy night.',
    pass: 'The kitchen got only the food, the bar only the drinks, and both show the same table.',
  },
  split_bill: {
    title: 'A split bill',
    how: 'Bill a table and let it pay two ways, for example part cash and part UPI.',
    pass: 'The bill shows both payments and closes once it is fully paid.',
  },
  free_dish: {
    title: 'A free dish',
    how: 'Give a dish on the house with a reason, approved with a manager’s PIN.',
    pass: 'It shows as free on the bill, with the reason and who approved it.',
  },
  cooked_cancel: {
    title: 'A cooked cancellation',
    how: 'Cancel a dish after the kitchen has made it, and say it was made.',
    pass: 'It is off the bill and counted as waste, not put back in stock.',
  },
  printer_out: {
    title: 'A printer out of paper',
    how: 'Take the paper out of a station printer (or switch it off) and send a dish there. Put it back and reprint.',
    pass: 'Every screen showed the ticket that did not print, and it printed once fixed.',
  },
  internet_off: {
    title: 'The internet off',
    how: 'Unplug the internet but keep the Wi-Fi on. Take two orders and one bill on two devices, then plug it back in.',
    pass: 'Nothing stopped, and once back online every order and bill appears once, none missing or doubled.',
  },
  day_end: {
    title: 'Day end and the accountant’s pack',
    how: 'Open Reports, check today’s day end, and download the month-end pack.',
    pass: 'The cash to expect and every payment add up, and the pack opens in Excel.',
  },
};
