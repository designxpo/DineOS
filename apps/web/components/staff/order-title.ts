import type { OrderDTO } from '@dineos/shared/dto';
import type { I18n } from '@/lib/i18n';

/** What staff call an order: its table, "Zomato #4821", own delivery, takeaway or counter. */
export function orderTitle(order: Pick<OrderDTO, 'table_label' | 'type' | 'channel' | 'channel_ref'>, t: I18n['t']): string {
  if (order.table_label) return t('order.table', { label: order.table_label });
  if (order.type === 'delivery' && order.channel) {
    const channel = t(`channel.${order.channel}`);
    return order.channel_ref ? t('order.delivery_ref', { channel, ref: order.channel_ref }) : channel;
  }
  return order.type === 'takeaway' ? t('order.takeaway') : t('order.counter');
}
