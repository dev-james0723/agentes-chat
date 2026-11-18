# Avatar

Pessoas e agentes usam o mesmo quadro arredondado, com raio de 30% nos tamanhos emoldurados. Pessoas mostram foto, retrato em pixels ou iniciais. Agentes mostram a foto salva em `avatarUrl`; sem foto, ou se a imagem falhar, mantêm o desenho em pixels com sua cor, olhos e acessório.

A foto preenche o quadro sem distorção (`object-fit: cover`, centralizada). A moldura, o nome acessível e a presença continuam no componente compartilhado. A foto não recorta o selo de presença. `ac-avatar--running` mantém o anel de trabalho mesmo no quadro; a foto em espera recebe um anel de atenção.

Tamanhos: 18, 24, 36 (padrão), 56 e 112px. Use `labelled` quando não houver nome visível ao lado. Na web, toda identidade de agente passa por `AgentAvatar`, que lê a foto atual do diretório pelo ID. O aplicativo móvel usa a mesma URL com autenticação apenas para imagens do próprio servidor.

A troca e a remoção da foto ficam em Configurações do agente, para quem pode editar seu jeito. O diálogo reutiliza o recorte quadrado de fotos de perfil. A imagem é independente da aparência em pixels, que permanece salva como alternativa.
