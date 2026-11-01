# Celeiro: como colocar no ar

Esta pasta é a versão de servidor do Celeiro. No servidor:

- cada pessoa entra com o próprio nome e uma senha (você e a Isabel);
- os dois veem e lançam nos mesmos números, e o que um lança aparece na hora na tela do outro;
- os dados ficam num arquivo (`celeiro.json`) dentro do disco do Railway, com uma cópia de segurança por dia (as últimas 30 ficam guardadas);
- o print do extrato é lido pelo Claude, usando a sua chave da API da Anthropic.

Nenhum dado financeiro fica nesta pasta nem no GitHub. Os números entram pelo próprio app, no primeiro acesso, com o arquivo `celeiro-dados.json`.

---

## Passo a passo (Railway + GitHub)

### 1. Suba esta pasta para o GitHub

1. Em <https://github.com>, clique em **New repository**, dê o nome `celeiro` e marque **Private**. Clique em **Create repository**.
2. Na página do repositório, clique em **uploading an existing file**.
3. Arraste **tudo o que está dentro** desta pasta: `servidor.js`, `package.json`, `package-lock.json`, `LEIA-ME.md` e a pasta `publico` inteira.
4. Clique em **Commit changes**.

### 2. Crie o serviço no Railway

Dá para usar o mesmo projeto do Ora et Labora.

1. Abra o projeto no Railway e clique em **New → GitHub Repo**. Escolha `celeiro`.
2. O Railway reconhece sozinho que é Node.js e começa a instalar.

### 3. Crie o disco onde ficam os dados (obrigatório)

Sem disco, os dados se perdem a cada atualização.

1. No projeto, clique com o botão direito no fundo da tela (ou aperte `Ctrl+K`) e escolha **Volume**.
2. Ligue o volume ao serviço `celeiro`.
3. Em **Mount path**, escreva `/data`.

### 4. Ligue a leitura de prints

1. Clique no serviço `celeiro` e vá em **Variables**.
2. Adicione `ANTHROPIC_API_KEY` com a sua chave da API da Anthropic. Pode ser a mesma do Ora et Labora.

Cada print lido custa alguns centavos de uso da API. Sem a chave, o resto do app funciona normalmente; só a leitura de prints fica desligada.

### 5. Gere o endereço

1. No serviço, vá em **Settings → Networking → Generate Domain**.
2. Vai aparecer algo como `celeiro-production.up.railway.app`.
3. Para um endereço próprio, como `celeiro.agenciacrown.com.br`, use **Custom Domain** no mesmo lugar e siga as instruções de DNS do Railway.

### 6. Primeiro acesso

1. Abra o endereço. Na primeira vez, ele pede para **criar a conta do administrador**: use seu nome e uma senha.
2. Em seguida aparece o celeiro vazio. Clique em **Escolher o arquivo celeiro-dados.json** e escolha o arquivo que veio junto com esta pasta. Orçamento, caixinhas, clientes, reservas e recebimentos entram de uma vez.
3. Vá em **Ajustes → Quem pode entrar** e crie a conta da Isabel. Mande para ela o endereço, o nome e a senha. Ela troca a senha em **Ajustes → Sua conta**.

### 7. No celular, como um aplicativo

- **iPhone (Safari):** abra o endereço, toque em **Compartilhar** e depois em **Adicionar à Tela de Início**.
- **Android (Chrome):** abra o endereço, toque nos três pontinhos e depois em **Adicionar à tela inicial** (ou **Instalar app**).

O Celeiro passa a abrir em tela cheia, com o ícone do celeiro, sem a barra do navegador. A sessão dura 90 dias em cada aparelho.

---

## Conferir se os dados estão seguros

Abra `https://SEU-ENDERECO/diagnostico`. A primeira linha diz se os dados estão num disco que sobrevive às atualizações. Se aparecer PROBLEMA, quase sempre é o volume do passo 3 que faltou ou ficou com outro caminho.

## Cópias de segurança

- Toda madrugada fica uma cópia em `/data/backups/celeiro-AAAA-MM-DD.json`. As últimas 30 são guardadas.
- Em **Ajustes → Cópia dos dados** você baixa uma cópia na hora. Guarde uma no Drive de vez em quando.
- O mesmo lugar tem **Restaurar de uma cópia**. Antes de substituir, o servidor guarda o estado atual em `/data/backups`.

## Variáveis opcionais

| Variável | Para quê | Padrão |
|---|---|---|
| `ANTHROPIC_MODELO` | modelo que lê os prints | `claude-sonnet-5-5` |
| `FUSO` | fuso usado nas datas das cópias | `America/Sao_Paulo` |
| `CELEIRO_DADOS` | pasta dos dados, se não usar volume do Railway | `./dados` |

## Como atualizar depois

Quando houver uma versão nova:

1. abra o repositório no GitHub;
2. entre na pasta `publico`, clique em `index.html` e use **Add file → Upload files** para trocar o arquivo (ou troque o `servidor.js`, se for o caso);
3. faça o commit.

O Railway publica a nova versão sozinho em um ou dois minutos, e os dados continuam no disco.

## Rodar no próprio computador (opcional)

Precisa do Node.js 20 ou mais novo. Na pasta, rode:

```
npm install
npm start
```

Depois abra <http://localhost:3000>.

## Porta do JARVIS (assistente do Mac)

O JARVIS consulta o mês e lança gastos direto pelo servidor, nas rotas `/api/jarvis/...`, sem abrir a tela.

- A chave fica só no `.env` do JARVIS, como `CELEIRO_TOKEN`. No Railway vai apenas a impressão digital dela, na variável `JARVIS_TOKEN_SHA256` (SHA-256 em hex; no Mac: `printf %s "CHAVE" | shasum -a 256`). Sem a variável, as rotas não existem.
- Ele lê o resumo do mês (caixinhas, fatura, reservas, faturamento da Crown) e os lançamentos, e pode lançar um gasto novo. Não apaga nem altera nada.
- O que ele lança aparece com "por: JARVIS" e pode ser desfeito ou apagado pela tela, como qualquer lançamento.
- Para desligar, apague a variável `JARVIS_TOKEN_SHA256`.
