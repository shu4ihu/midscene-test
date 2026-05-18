import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';

const agent = new AgentOverChromeBridge();
await agent.connectNewTabWithUrl('https://www.bing.com');

await agent.ai('search "AI automation" and summarise first result');
await agent.aiAssert('some search results show up');
await agent.destroy();