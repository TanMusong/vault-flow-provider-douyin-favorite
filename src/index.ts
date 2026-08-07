import type { ProviderDefinition } from '@vault-flow/provider-api';
import { DouyinFavoriteProvider } from './provider';

const createDouyinFavoriteProvider: ProviderDefinition = () => new DouyinFavoriteProvider();

export default createDouyinFavoriteProvider;
