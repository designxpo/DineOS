import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context';
import admin from './admin/routes';
import approvals from './approvals/routes';
import auth from './auth/routes';
import billing from './billing/routes';
import customers from './customers/routes';
import devices from './devices/routes';
import events from './events/routes';
import guest from './guest/routes';
import hub from './hub/routes';
import inventory from './inventory/routes';
import menu from './menu/routes';
import orders from './orders/routes';
import outlets from './outlets/routes';
import print from './print/routes';
import reports from './reports/routes';
import reservations from './reservations/routes';
import staff from './staff/routes';
import tables from './tables/routes';

/** Every module exposes `routes(ctx)`; all are mounted under /v1. */
export const modules: Record<string, (ctx: AppContext) => FastifyPluginAsync> = {
  auth,
  approvals,
  outlets,
  staff,
  menu,
  tables,
  guest,
  orders,
  billing,
  customers,
  reservations,
  inventory,
  reports,
  admin,
  print,
  devices,
  hub,
  events,
};
