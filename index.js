require('dotenv').config();
const axios = require('axios');

// 🔍 Carregando variáveis de ambiente com segurança
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const TINY_TOKEN = process.env.TINY_TOKEN || '';

console.log("✅ SUPABASE_URL carregada:", SUPABASE_URL);
console.log("✅ SUPABASE_KEY carregada:", SUPABASE_KEY ? '✔️ OK' : '❌ VAZIA');
console.log("✅ TINY_TOKEN carregada:", TINY_TOKEN ? '✔️ OK' : '❌ VAZIA');

const LIMITE = 500;
const INTERVALO = 1500;
const MAX_POR_MINUTO = 40;
const PAUSA_ENTRE_LOTES = 2 * 60 * 1000; // 2 minutos

function parseFloatSafe(str) {
  const val = parseFloat((str || '0').toString().replace(',', '.'));
  return isNaN(val) ? 0 : val;
}

async function buscarPedidosPendentes() {
  const url = `${SUPABASE_URL}/rest/v1/api_tiny_pedidos?select=ID,log_api&order=ID.desc&limit=${LIMITE}&or=(log_api.is.null,log_api.not.like.✅*)`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
  const res = await axios.get(url, { headers });
  return res.data;
}

async function consultarTiny(id) {
  const payload = new URLSearchParams({
    token: TINY_TOKEN,
    id: id.toString(),
    formato: 'json'
  });

  const res = await axios.post('https://api.tiny.com.br/api2/pedido.obter.php', payload);
  return res.data;
}

async function atualizarPedido(id, body) {
  const url = `${SUPABASE_URL}/rest/v1/api_tiny_pedidos?ID=eq.${id}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };
  await axios.patch(url, body, { headers });
}

async function marcarErro(id, erro) {
  const url = `${SUPABASE_URL}/rest/v1/api_tiny_pedidos?ID=eq.${id}`;
  const body = {
    log_api: `❌ ${erro} (${new Date().toLocaleString('pt-BR')})`
  };
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
  await axios.patch(url, body, { headers });
}

async function processarLote() {
  console.log('🔍 Buscando pedidos pendentes...');
  const pedidos = await buscarPedidosPendentes();

  if (!pedidos || pedidos.length === 0) {
    console.log('🏁 Nenhum pedido restante. Aguardando próxima tentativa...');
    return false;
  }

  console.log(`📦 ${pedidos.length} pedidos encontrados.`);
  let count = 0;

  for (const pedido of pedidos) {
    if (count >= MAX_POR_MINUTO) {
      console.log('⏳ Aguardando 60s por limite da API Tiny...');
      await new Promise(r => setTimeout(r, 60000));
      count = 0;
    }

    try {
      const resposta = await consultarTiny(pedido.ID);

      if (resposta?.retorno?.status === 'OK') {
        const dados = resposta.retorno.pedido;
        const totalPedido = parseFloatSafe(dados.total_pedido);
        const totalProdutos = parseFloatSafe(dados.total_produtos);
        const formaPagamento = dados.forma_pagamento || 'Não informado';
        const marcadores = (dados.marcadores || []).map(m => m.marcador?.descricao).filter(Boolean).join(' | ') || 'Nenhum';
        const formaFrete = dados.forma_frete || 'Não informado';
        const rastreio = dados.codigo_rastreamento || null;
        const urlRastreio = dados.url_rastreamento || null;

        let totalItens = 0;
        if (dados.itens?.length > 0) {
          totalItens = dados.itens.reduce((sum, i) => sum + parseFloatSafe(i.item?.quantidade), 0);
        }

        const body = {
          "Total do pedido": totalPedido,
          "Forma de Pagamento": formaPagamento,
          "Marcadores": marcadores,
          "Forma de Envio": formaFrete,
          "log_api": `✅ Processado em ${new Date().toLocaleString('pt-BR')}`,
          "Cod. de Rastreio": rastreio,
          "URL de Rastreio": urlRastreio,
          "Total dos produtos": totalProdutos,
          "N. de Itens": totalItens
        };

        await atualizarPedido(pedido.ID, body);
        console.log(`✅ Pedido ${pedido.ID} atualizado`);
      } else {
        const msg = JSON.stringify(resposta?.retorno?.erros || 'Erro desconhecido');
        if (msg.includes("bloqueada") || msg.includes("excedido")) {
          console.log(`🚫 API BLOQUEADA. Pausando por 5 minutos...`);
          await new Promise(r => setTimeout(r, 5 * 60 * 1000));
          continue;
        }
        throw new Error(msg);
      }
    } catch (e) {
      console.log(`❌ Erro no pedido ${pedido.ID}: ${e.message}`);
      await marcarErro(pedido.ID, e.message);
    }

    count++;
    await new Promise(r => setTimeout(r, INTERVALO));
  }

  return true;
}

async function loop() {
  while (true) {
    const tevePedidos = await processarLote();
    console.log(`🕑 Aguardando ${PAUSA_ENTRE_LOTES / 60000} minutos antes do próximo lote...`);
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_LOTES));
  }
}

loop();
