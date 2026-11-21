/**
 * @bestie/core — pure domain logic (no React, no I/O, no framework imports).
 * Money in integer satang, VAT / service charge / rounding, module registry + `isEnabled`,
 * profile presets, Points rules, Credit legal guards.
 */
export * from './money';
export * from './rounding';
export * from './tax';
export * from './profiles';
export * from './modules/registry';
export * from './modules/enabled';
export * from './points';
export * from './credit';
export * from './menu';
export * from './types';

/** Every price, bill and ledger is THB (CLAUDE.md rule 1). */
export const CURRENCY = 'THB' as const;
export * from './audit';
export * from './csv';
export * from './brand';
export * from './ai';
export * from './aiPrompts';
export * from './flex';
export * from './billing';
export * from './backoffice';
export * from './menuAdmin';
export * from './outbox';
export * from './orders';
export * from './payments';
export { receiptFromRows } from './receiptRows';
export * from './split';
export * from './shifts';
export * from './kitchen';
export * from './reports';
export * from './guestCart';
export * from './customers';
export * from './splitTender';
export * from './crypto';
export * from './dietary';
export * from './storeTheme';
export * from './cardImages';
export * from './aiCost';
export * from './printing';
export * from './askShop';
export * from './kitchenTicket';
export * from './printJobs';
export * from './shopInfo';
export * from './stock';
export * from './purchasing';
export * from './appointments';
export * from './onlineBooking';
export * from './barcode';
export * from './menuImages';
export * from './barcode128';
export * from './labels';
export * from './returns';
export * from './blocks';
export * from './clientRecords';
export * from './hairAdvisor';
export * from './commission';
export * from './packages';
